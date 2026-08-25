"""S-score reader+judge pass via direct Nous API (ox-alpha) — 10 parallel workers.

Reads the recall run's reconstructed inputs (inputs.json from scored_run.py
reconstruct+reader or fresh), answers each question (reader), then grades it
(judge). Both steps use the SAME free-fleet model (stealth/ox-alpha) with
transparent fallback to other Nous models on upstream 429.

The scoring contract mirrors LongMemEval: reader answers from the retrieved
context; judge grades answer vs gold with per-type rubrics.

Usage:
  python3 bench/nous_scored.py --run 20260824-221606 --workers 10
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import pathlib
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
RUNS = HERE / "runs"

BASE = "https://inference-api.nousresearch.com/v1/chat/completions"
# Three independent ox-alpha gateways: direct Nous API, CommandCode, OpenRouter.
# Each is a separate upstream pool, so a 429 on one doesn't block the others.
GATEWAYS = [
    {"url": BASE, "key": "nous-a1"},
    {"url": BASE, "key": "nous-a2"},
    {"url": BASE, "key": "nous-a3"},
    {"url": "https://api.commandcode.ai/provider/v1/chat/completions",
     "key": "command-code"},
    {"url": "https://openrouter.ai/api/v1/chat/completions",
     "key": "openrouter-a1"},
]
MODELS = ["stealth/ox-alpha"]  # only model these keys can call; others 404/403

SYSTEM = """You answer questions from a user's own chat history.
Rules:
- Each session below is timestamped. Use the timestamps for any question about
  when something happened, or about what is currently true.
- When two sessions conflict, the LATER timestamp wins — the user changed
  their mind or updated the fact.
- The sessions are ranked by retrieval relevance, not by truth: irrelevant
  sessions may be present and relevant details may sit deep inside a long
  session. Scan ALL of them before concluding the answer is absent.
- If the sessions genuinely do not contain the answer, reply exactly NO_ANSWER.
  Do not guess. An invented answer is worse than an admitted gap.
- Otherwise answer concisely and directly."""

# ox-alpha serves a ~1M-token window; the old 12-session x 6000-char cap
# discarded the answer in 648/681 gold-in-context cases (v1 analysis).
# Full bodies of all retrieved sessions max out near 220k chars (~55k tokens).
MAX_SESSIONS = 0   # 0 = no cap, keep every retrieved session
MAX_BODY_CHARS = 0 # 0 = no truncation

RUBRIC = {
    "temporal-reasoning":
        "The response must identify the correct time or ordering. "
        "A right fact with the wrong date is INCORRECT.",
    "knowledge-update":
        "The response must reflect the MOST RECENT state. "
        "Citing a superseded earlier value is INCORRECT.",
    "single-session-preference":
        "The response must respect the user's stated preference.",
}
DEFAULT_RUBRIC = "The response must contain the correct answer."


def _keys() -> list[tuple[str, str]]:
    import json as j
    auth = j.loads(pathlib.Path.home().joinpath(
        ".pi", "agent", "auth.json").read_text())
    out = []
    for g in GATEWAYS:
        k = auth.get(g["key"])
        if k:
            key = k.get("key") or k.get("api_key") or ""
            if key:
                out.append((g["url"], key))
    return out


def _call(messages: list[dict], max_tokens: int = 512) -> str:
    """One completion across 5 gateways (3×nous, cc, or) with rotation.

    Retries are classified: 429/capacity/empty-content rotate to the next
    gateway with short backoff (empty content is a known upstream flake,
    not a prompt problem); other errors back off longer. Only after the
    full rotation budget fails does it raise — v1 raised on the first
    empty-content run, stranding 40 questions as correct=None."""
    gw = _keys()
    body = json.dumps({"model": MODELS[0], "messages": messages,
                       "max_tokens": max_tokens}).encode()
    last_err = ""
    for attempt in range(10):
        url, key = gw[attempt % len(gw)]
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                                    "Chrome/126.0.0.0 Safari/537.36"})
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                d = json.loads(resp.read())
                content = d["choices"][0]["message"].get("content")
                if not content or not content.strip():
                    raise RuntimeError("empty content")
                return content.strip()
        except Exception as e:
            last_err = str(e)
            err = str(e)
            if "429" in err or "capacity" in err.lower() or "unavailable" in err.lower():
                time.sleep(2 + attempt % 4)
                continue
            if "empty content" in err or "403" in err:
                time.sleep(1)
                continue
            if isinstance(e, urllib.error.HTTPError):
                e.close()
            time.sleep(min(2 * attempt, 15))
    raise RuntimeError(f"all calls failed after {10 * len(gw)} attempts: {last_err}")


def _reader(item: dict) -> str:
    parts = [SYSTEM, "",
             f"The question is being asked on: {item['question_date']}", ""]
    if item.get("context"):
        parts.append("Relevant sessions from the user's history:")
        sessions = item["context"]
        if MAX_SESSIONS:
            sessions = sessions[:MAX_SESSIONS]
        for c in sessions:
            parts.append(f"\n--- {c['title']} ---")
            body = c.get("body") or ""
            if MAX_BODY_CHARS:
                body = body[:MAX_BODY_CHARS]
            parts.append(body)
    else:
        parts.append("No sessions were retrieved.")
    parts += ["", f"Question: {item['question']}", "", "Answer:"]
    # 512 hit finish_reason=length on long prompts (reasoning consumed the
    # budget before any content was emitted) — 31/490 questions stranded as
    # empty-content. 4096 leaves room for reasoning + the answer itself.
    return _call([{"role": "user", "content": "\n".join(parts)}], max_tokens=4096)


def _grade(item: dict, response: str) -> bool:
    if str(item["question_id"]).endswith("_abs") or \
       item.get("answer") in (None, "", "NO_ANSWER"):
        return "NO_ANSWER" in (response or "").upper()
    rubric = RUBRIC.get(item["question_type"], DEFAULT_RUBRIC)
    prompt = (f"{rubric}\n\n"
              f"Question: {item['question']}\n"
              f"Correct answer: {item['answer']}\n"
              f"Model response: {response}\n\n"
              "Reply with exactly one word: CORRECT or INCORRECT.")
    out = _call([{"role": "user", "content": prompt}], max_tokens=512)
    return out.strip().upper().startswith("CORRECT")


def _work(item: dict) -> dict:
    resp = _reader(item)
    correct = _grade(item, resp)
    return {"question_id": item["question_id"],
            "question_type": item["question_type"],
            "correct": correct, "response": resp}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0,
                    help="0 = all; else first N (smoke test)")
    ap.add_argument("--resume", action="store_true",
                    help="reuse prior non-ERROR responses from nous_graded.json; "
                         "only re-run missing/errored items")
    args = ap.parse_args()

    scored_dir = RUNS / args.run / "scored"
    items = json.loads((scored_dir / "inputs.json").read_text())

    # Resume: keep prior good answers (reader output is deterministic input
    # for the judge only when we reuse BOTH reader+judge result — so a kept
    # row must have a non-ERROR response and a boolean verdict).
    prior: dict[str, dict] = {}
    if args.resume:
        gp = scored_dir / "nous_graded.json"
        if gp.exists():
            for r in json.loads(gp.read_text()):
                if r.get("correct") is not None \
                        and not str(r.get("response", "")).startswith("ERROR"):
                    prior[r["question_id"]] = r
        items = [i for i in items if i["question_id"] not in prior]
        print(f"resume: {len(prior)} kept, {len(items)} to (re)run")

    if args.limit:
        items = items[: args.limit]

    t0 = time.time()
    done = 0
    results = []
    with concurrent.futures.ThreadPoolExecutor(
            max_workers=args.workers) as pool:
        futures = {pool.submit(_work, it): it for it in items}
        for fut in concurrent.futures.as_completed(futures):
            try:
                r = fut.result()
            except Exception as e:
                r = {"question_id": futures[fut]["question_id"],
                     "question_type": futures[fut]["question_type"],
                     "correct": None, "response": f"ERROR: {e}"}
            results.append(r)
            done += 1
            if done % 20 == 0:
                el = time.time() - t0
                print(f"  {done}/{len(items)} in {el:.0f}s "
                      f"({el/max(done,1):.1f}s/q)", flush=True)

    results.extend(prior.values())
    results.sort(key=lambda r: r["question_id"])

    (scored_dir / "nous_graded.json").write_text(
        json.dumps(results, indent=1), encoding="utf-8")
    graded = [r for r in results if r["correct"] is not None]
    errors = len(results) - len(graded)
    overall = sum(r["correct"] for r in graded) / len(graded)
    by_type = {}
    for r in graded:
        by_type.setdefault(r["question_type"], []).append(r["correct"])
    summary = {"run": args.run, "n": len(graded), "errors": errors,
               "overall": overall,
               "by_type": {k: sum(v) / len(v) for k, v in by_type.items()}}
    (scored_dir / "s_score.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8")
    print(f"done {len(graded)} graded in {time.time()-t0:.0f}s")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
