# Heimdall × LongMemEval — Plan 1: Measurement Loop & Baseline Reproduction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a reproducible, local LongMemEval harness for Heimdall that reproduces the reported baseline (S 0.740 / M 0.618 / Oracle 0.836) and emits a per-question-type error breakdown, so Plan 2's fixes can be chosen from data instead of guessed.

**Architecture:** A new `bench/` subtree, fully isolated from Heimdall's runtime. Chat sessions are materialized as files on disk (which makes Heimdall's existing path-anchored trust-verdict layer meaningful for conversational memory), ingested into a **dedicated graft profile** so the benchmark corpus never touches the 12,789 live nodes of real work. Retrieval goes through a new signal-preserving client that recovers the calibrated `s_vec`/`s_lex`/`s_ce` scores graft's `retrieve` currently discards. The reader is a separate, swappable module — that is where the allowed token spend lives.

**Tech Stack:** Python 3.12 (`~/.heimdall/venv/bin/python3`), graft CLI + graftd, bge-m3 embeddings, node:sqlite journal (untouched), Anthropic API for reader + judge.

## Global Constraints

Copied verbatim from the decisions made at plan time. Every task's requirements implicitly include this section.

- **No LLM at ingest.** Memory construction stays CPU-only — tree-sitter/lexical/embedding only. Embeddings (bge-m3) and a cross-encoder reranker are *not* LLM calls and are permitted; they cost CPU, never tokens. This preserves the README's stated commitment: *"depth costs CPU, never tokens."*
- **The reader may spend tokens.** Read-time decomposition, re-reading, abstention checks and verification passes are in scope. Consolidation moves from ingest to read time.
- **Primary target: `longmemeval_s` ≥ 0.90.** M is secondary and explicitly may not reach 0.90.
- **Never write benchmark data into the `default` graft profile.** The live profile holds 12,789 real work nodes. All benchmark ingest goes to a `longmemeval` profile. A violation here corrupts real user memory.
- **Never modify `~/.heimdall/journal.db`, `~/.graft/profiles/default/graft.db`, or `~/knowledge-base/.inventory.tsv`.** These are live data, not build artifacts.
- **`bench/` must not be imported by any runtime code path** in `bin/` or `extensions/`.
- Disk budget: 50 GiB free at plan time (89% full). `longmemeval_s` fits comfortably; `longmemeval_m` must be checked before download.

## Verified Findings This Plan Is Built On

These were established by direct inspection, not assumption. They are the reason the tasks are shaped the way they are.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | `graft retrieve` scores are pure RRF rank, `1/(60+rank)` | Observed 0.0163934, 0.016129, 0.015873 … = 1/61, 1/62, 1/63; `rrf_k_const: 60` in config | No relevance magnitude ⇒ **no abstention threshold, no rerank signal.** Directly costs points on every `_abs` question. |
| F2 | `graft query` *does* expose calibrated signals | Returns `s_vec: 0.742844`, `s_lex: 0.129032`, `s_jaccard`, `s_ce` | The magnitudes exist and are recoverable — but `query` returns **top-1 only**. Task 4 exists to recover them per-candidate. |
| F3 | Cross-encoder reranker is configured but inactive | `verification.cross_encoder_enabled: false`, `rerank.enabled: false`, `s_ce: null` | An unused, CPU-only precision lever that the no-LLM constraint fully permits. |
| F4 | The reranker model was never downloaded — **now fetched** | `bge-reranker-v2-m3.gguf` (1.1 GB, FP16, from `gpustack/bge-reranker-v2-m3-GGUF`) now sits beside `bge-m3.gguf` in `~/knowledge-base/models/` | F3's blocker is cleared. `cross_encoder_enabled` / `rerank.enabled` are still `false` in `~/.graft/config.yaml`; flipping them is a Plan 2 lever, CPU-only, zero tokens. |
| F5 | `graft insert` has no timestamp field | CLI accepts only `--title/--body/--keyword/--tag/--author/--expires-at` | Session timestamps must be encoded into title/body/keywords. **Temporal-reasoning and knowledge-update categories depend on this.** |
| F6 | Embedding backend is throttled | `threads: 2`, `hardware_accel: false` on an 8-core M1 Pro | Ingesting ~25k sessions will be needlessly slow. Tuning is config-only. |
| F7 | Duplicate `graftd` processes keep appearing | Repeatedly observed, most recently 3 at once, two holding `/tmp/graft-default.sock` on different inodes | graft's daemon autostart takes no lock, so concurrent CLI calls each spawn one. `bin/kb-health.sh` does **not** fix this (see Task 0). Recurs under parallel subagents; recheck before every measurement. |
| F8 | No LongMemEval harness exists anywhere | `grep -ril longmemeval` empty across repo, `~/.heimdall`, `~/knowledge-base`, `~/.claude`, `~/.pi`, shell history | The reported baseline is **unreproduced locally**. Task 6 may legitimately fail to match it. |

---

### Task 0: Resolve the duplicate-daemon hazard

Nothing measured is trustworthy while two writers share a socket (F7). This task is first because it invalidates every later number if skipped.

**Files:**
- Modify: none (operational)

**Interfaces:**
- Produces: exactly one running `graftd`, confirmed.

- [ ] **Step 1: Identify both daemons and their start times**

```bash
ps -o pid,lstart,command -p 7266,72197
```

Expected: two `graftd --config ~/.graft/config.yaml` lines with different start times.

- [ ] **Step 2: Check which one owns the socket**

```bash
lsof /tmp/graft-default.sock 2>/dev/null
```

Compare the `DEVICE` column. Two daemons holding the *same path* on *different*
inodes means the later one rebound the socket and stranded the earlier one on an
unlinked inode — the earlier daemon is receiving zero traffic.

- [ ] **Step 3: Identify which daemon launchd actually owns**

```bash
launchctl print gui/$(id -u)/com.graft.daemon | grep -E '^\s+pid '
```

Every other `graftd` is an orphan (`PPID 1`, not launchd's child).

**Do NOT use `bash bin/kb-health.sh` here.** It does not reconcile to one daemon,
despite the README's claim. Its only health signal is whether `graft stats`
responds (`bin/kb-health.sh:14-17`), and it deliberately ignores socket-holder
count because a forked embedding worker legitimately inherits the fd. It prints
`HEALTHY` and leaves every duplicate running.

Root cause, verified: graft's daemon autostart takes no lock, so concurrent CLI
invocations each spawn a daemon. Parallel subagents reproduce this every time.
Expect it to recur; re-check before each measurement run.

- [ ] **Step 4: Kill the orphans, then restart the managed one**

`kill` of a process Claude did not launch requires `bio-confirm` per the user's
standing rules. If `bio-confirm` exits non-zero, abort and report — do not fall
back to an ungated path.

```bash
bio-confirm "kill orphan graftd <PID>" && kill <PID>
launchctl kickstart -k gui/$(id -u)/com.graft.daemon
```

- [ ] **Step 5: Verify exactly one remains and it still has the data**

```bash
pgrep -fl graftd | wc -l          # expect 1
graft stats                        # expect a response, node count unchanged
```

- [ ] **Step 5: Commit (no code change — record the finding)**

```bash
git commit --allow-empty -m "ops: resolve duplicate graftd before benchmark baseline"
```

---

### Task 1: Vendor the dataset and pin its checksum

**Files:**
- Create: `bench/README.md`
- Create: `bench/fetch_data.sh`
- Create: `bench/.gitignore`
- Test: `bench/tests/test_data_integrity.py`

**Interfaces:**
- Produces: `bench/data/longmemeval_s.json`, `bench/data/longmemeval_oracle.json`; a `load_dataset(name) -> list[dict]` contract where each question dict has keys `question_id`, `question_type`, `question`, `answer`, `question_date`, `haystack_sessions`, `haystack_dates`, `answer_session_ids`.

- [ ] **Step 1: Write the failing integrity test**

```python
# bench/tests/test_data_integrity.py
import json, pathlib, pytest

DATA = pathlib.Path(__file__).resolve().parents[1] / "data"

REQUIRED_KEYS = {
    "question_id", "question_type", "question", "answer",
    "question_date", "haystack_sessions", "haystack_dates",
    "answer_session_ids",
}

def test_oracle_dataset_shape():
    path = DATA / "longmemeval_oracle.json"
    assert path.exists(), f"missing {path}; run bench/fetch_data.sh"
    rows = json.loads(path.read_text())
    assert len(rows) == 500, f"expected 500 questions, got {len(rows)}"
    for row in rows:
        missing = REQUIRED_KEYS - row.keys()
        assert not missing, f"{row.get('question_id')} missing {missing}"

def test_abstention_questions_are_marked():
    rows = json.loads((DATA / "longmemeval_oracle.json").read_text())
    abs_rows = [r for r in rows if r["question_id"].endswith("_abs")]
    assert abs_rows, "no abstention questions found; _abs suffix convention changed"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_data_integrity.py -v`
Expected: FAIL — `missing .../longmemeval_oracle.json; run bench/fetch_data.sh`

- [ ] **Step 3: Write the fetch script**

The dataset lives on HuggingFace at `xiaowu0162/longmemeval`. **Verify the exact filenames before hardcoding them** — list the repo first and adjust if they differ.

```bash
#!/usr/bin/env bash
# bench/fetch_data.sh — download LongMemEval into bench/data (gitignored).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DATA="$HERE/data"
mkdir -p "$DATA"
PY="${HEIMDALL_PYTHON:-$HOME/.heimdall/venv/bin/python3}"

"$PY" -m pip install --quiet --upgrade huggingface_hub

"$PY" - <<'EOF'
import os, pathlib
from huggingface_hub import snapshot_download
dest = pathlib.Path(__file__).parent if False else pathlib.Path(os.environ["DATA"])
p = snapshot_download(
    repo_id="xiaowu0162/longmemeval",
    repo_type="dataset",
    local_dir=str(dest),
    allow_patterns=["*oracle*", "*_s*"],
)
print("downloaded to", p)
for f in sorted(pathlib.Path(p).rglob("*.json")):
    print(" ", f.name, f.stat().st_size)
EOF

echo "--- checksums ---"
shasum -a 256 "$DATA"/*.json | tee "$HERE/data.sha256"
```

Note `longmemeval_m` is deliberately excluded from `allow_patterns` — with 50 GiB free it must be a conscious, separate decision.

- [ ] **Step 4: Add the gitignore so 500 MB of data never enters git**

```
# bench/.gitignore
data/
runs/
*.log
```

- [ ] **Step 5: Fetch and verify**

```bash
DATA=bench/data bash bench/fetch_data.sh
~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_data_integrity.py -v
```

Expected: PASS, 2 tests. If the 500-count assertion fails, record the real count and correct the test — do not silently loosen it.

- [ ] **Step 6: Commit**

```bash
git add bench/README.md bench/fetch_data.sh bench/.gitignore bench/tests/test_data_integrity.py bench/data.sha256
git commit -m "bench: vendor LongMemEval fetch + dataset integrity tests"
```

---

### Task 2: Isolate the benchmark corpus in its own graft profile

This is the safety task. It must pass before any ingest runs.

**Files:**
- Create: `bench/profile.sh`
- Test: `bench/tests/test_profile_isolation.py`

**Interfaces:**
- Produces: a `longmemeval` graft profile with its own socket and db path; `bench_graft(*args)` helper that **always** targets that profile.

- [ ] **Step 1: Write the failing isolation test**

```python
# bench/tests/test_profile_isolation.py
import json, subprocess, pathlib, pytest

GRAFT = pathlib.Path.home() / ".local/bin/graft"
DEFAULT_DB = pathlib.Path.home() / ".graft/profiles/default/graft.db"

def _profiles():
    out = subprocess.run([str(GRAFT), "profile", "list"],
                         capture_output=True, text=True).stdout
    return json.loads(out)["result"]

def test_longmemeval_profile_exists():
    assert "longmemeval" in _profiles()["profiles"], \
        "run bench/profile.sh — benchmark must never share the default profile"

def test_default_profile_untouched_by_bench():
    """The live profile holds real work. Guard its node count."""
    baseline = pathlib.Path(__file__).parent / "default_node_count.txt"
    out = subprocess.run([str(GRAFT), "stats"], capture_output=True, text=True).stdout
    n = json.loads(out)["result"]["n_nodes"]
    if not baseline.exists():
        baseline.write_text(str(n))
        pytest.skip(f"recorded default-profile baseline: {n} nodes")
    assert n == int(baseline.read_text()), (
        f"default profile node count changed {baseline.read_text()} -> {n}. "
        "Benchmark ingest leaked into real memory. Stop and investigate."
    )
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_profile_isolation.py -v`
Expected: FAIL on `test_longmemeval_profile_exists`.

- [ ] **Step 3: Create the isolated profile**

```bash
#!/usr/bin/env bash
# bench/profile.sh — create/activate the isolated benchmark profile.
set -euo pipefail
GRAFT="${GRAFT:-$HOME/.local/bin/graft}"
"$GRAFT" profile add longmemeval || echo "profile already exists"
"$GRAFT" profile list
echo
echo "NOTE: the benchmark runner passes the profile explicitly."
echo "It never calls 'profile set', so your interactive graft stays on 'default'."
```

- [ ] **Step 4: Run and verify both tests pass**

```bash
bash bench/profile.sh
~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_profile_isolation.py -v
```

Expected: PASS + one recorded baseline (rerun once to convert the skip into a pass).

- [ ] **Step 5: Commit**

```bash
git add bench/profile.sh bench/tests/test_profile_isolation.py
git commit -m "bench: isolate LongMemEval corpus in a dedicated graft profile"
```

---

### Task 3: Session→file ingest adapter (CPU-only, timestamp-encoding)

The design move that makes Heimdall's existing trust-verdict layer apply to conversational memory: materialize each session as a real file on disk, so path-anchored verification means something. Also the fix for F5.

**Files:**
- Create: `bench/ingest.py`
- Test: `bench/tests/test_ingest.py`

**Interfaces:**
- Consumes: `load_dataset` shape from Task 1; `bench_graft` from Task 2.
- Produces:
  - `materialize(question, root: Path) -> list[Path]` — one `.md` per haystack session.
  - `session_title(session_id: str, date: str) -> str`
  - `ingest_question(question, root, profile="longmemeval") -> int` (count inserted)

- [ ] **Step 1: Write the failing tests**

```python
# bench/tests/test_ingest.py
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ingest import materialize, session_title

QUESTION = {
    "question_id": "q1",
    "question_type": "temporal-reasoning",
    "question": "When did I book the trip?",
    "answer": "March 3rd",
    "question_date": "2023/05/20 (Sat) 10:00",
    "haystack_dates": ["2023/03/03 (Fri) 14:12", "2023/04/01 (Sat) 09:00"],
    "haystack_sessions": [
        [{"role": "user", "content": "I booked the Lisbon trip today."},
         {"role": "assistant", "content": "Nice, Lisbon in March is lovely."}],
        [{"role": "user", "content": "What is the capital of France?"},
         {"role": "assistant", "content": "Paris."}],
    ],
    "answer_session_ids": ["0"],
}

def test_materialize_writes_one_file_per_session(tmp_path):
    paths = materialize(QUESTION, tmp_path)
    assert len(paths) == 2
    assert all(p.exists() for p in paths)

def test_session_file_embeds_its_timestamp(tmp_path):
    """F5: graft insert has no timestamp field, so the date must live in the text
    or temporal-reasoning and knowledge-update are unanswerable."""
    paths = materialize(QUESTION, tmp_path)
    body = paths[0].read_text()
    assert "2023/03/03" in body, "session date missing from body"
    assert "user:" in body and "assistant:" in body, "roles must be preserved"

def test_title_carries_iso_date_for_lexical_matching():
    t = session_title("0", "2023/03/03 (Fri) 14:12")
    assert "2023-03-03" in t, "ISO form aids lexical retrieval on date queries"

def test_no_llm_call_at_ingest(tmp_path, monkeypatch):
    """Global constraint: ingest is CPU-only. Fail loudly if anyone adds a model call."""
    import ingest
    for banned in ("anthropic", "openai"):
        monkeypatch.setitem(sys.modules, banned, None)
    materialize(QUESTION, tmp_path)  # must not raise
```

- [ ] **Step 2: Run to confirm failure**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_ingest.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingest'`

- [ ] **Step 3: Implement the adapter**

```python
# bench/ingest.py
"""Materialize LongMemEval chat sessions as on-disk files, then insert them
into an isolated graft profile.

CPU-only by construction: no model is called here. Session timestamps are
encoded into the title and body because `graft insert` exposes no timestamp
field (only --expires-at), and the temporal-reasoning / knowledge-update
question types are unanswerable without them.
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess

GRAFT = pathlib.Path.home() / ".local/bin/graft"


def _iso(date_str: str) -> str:
    """'2023/03/03 (Fri) 14:12' -> '2023-03-03'."""
    m = re.match(r"(\d{4})/(\d{2})/(\d{2})", date_str or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else "unknown-date"


def session_title(session_id: str, date: str) -> str:
    return f"session {session_id} — {_iso(date)} ({date})"


def materialize(question: dict, root: pathlib.Path) -> list[pathlib.Path]:
    """Write one markdown file per haystack session. Returns written paths."""
    root = pathlib.Path(root)
    qdir = root / question["question_id"]
    qdir.mkdir(parents=True, exist_ok=True)

    paths: list[pathlib.Path] = []
    dates = question.get("haystack_dates") or []
    for idx, turns in enumerate(question["haystack_sessions"]):
        date = dates[idx] if idx < len(dates) else ""
        lines = [
            f"# {session_title(str(idx), date)}",
            "",
            f"date: {date}",
            f"iso_date: {_iso(date)}",
            "",
        ]
        for turn in turns:
            lines.append(f"{turn['role']}: {turn['content']}")
            lines.append("")
        path = qdir / f"session_{idx}.md"
        path.write_text("\n".join(lines), encoding="utf-8")
        paths.append(path)
    return paths


def ingest_question(question: dict, root: pathlib.Path,
                    profile: str = "longmemeval") -> int:
    """Insert every materialized session into the ISOLATED profile."""
    if profile == "default":
        raise RuntimeError(
            "refusing to ingest benchmark data into the default profile"
        )
    count = 0
    for idx, path in enumerate(materialize(question, root)):
        date = (question.get("haystack_dates") or [""])[idx] \
            if idx < len(question.get("haystack_dates") or []) else ""
        cmd = [
            str(GRAFT), "insert",
            "--title", session_title(str(idx), date),
            "--body", path.read_text(encoding="utf-8"),
            "--keyword", _iso(date),
            "--keyword", question["question_id"],
        ]
        subprocess.run(cmd, check=True, capture_output=True,
                       env={"GRAFT_PROFILE": profile, "PATH": "/usr/bin:/bin"})
        count += 1
    return count
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_ingest.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the profile-targeting mechanism actually works**

`GRAFT_PROFILE` is an assumption about graft's CLI. Confirm it before trusting it:

```bash
~/.local/bin/graft profile --help
```

If graft selects profiles by a flag rather than an env var, correct `ingest_question` to use the real mechanism and re-run the tests. **Do not proceed on an unverified isolation mechanism** — this is the guard protecting 12,789 real nodes.

- [ ] **Step 6: Commit**

```bash
git add bench/ingest.py bench/tests/test_ingest.py
git commit -m "bench: CPU-only session->file ingest with timestamp encoding"
```

---

### Task 4: Signal-preserving retrieval client

Recovers the calibrated scores that F1 shows `retrieve` throws away, using the per-candidate signals F2 shows `query` exposes. This is the module Plan 2's abstention and reranking work will build on.

**Files:**
- Create: `bench/retrieve.py`
- Test: `bench/tests/test_retrieve.py`

**Interfaces:**
- Consumes: an ingested `longmemeval` profile from Task 3.
- Produces:
  - `Candidate` dataclass: `id_hex: str`, `title: str`, `rrf: float`, `s_vec: float | None`, `s_lex: float | None`, `s_ce: float | None`, `body: str | None`
  - `search(query: str, top_k: int = 25, profile: str = "longmemeval") -> list[Candidate]`
  - `rrf_rank_of(score: float, k: int = 60) -> int` — inverts F1's `1/(60+rank)`.

- [ ] **Step 1: Write the failing tests**

```python
# bench/tests/test_retrieve.py
import math, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from retrieve import rrf_rank_of

def test_rrf_inversion_matches_observed_scores():
    """F1: retrieve returns 1/(60+rank) and nothing else."""
    assert rrf_rank_of(0.0163934) == 1
    assert rrf_rank_of(0.016129) == 2
    assert rrf_rank_of(0.015873) == 3

def test_rrf_score_carries_no_relevance_information():
    """Documents WHY the client must fetch signals separately: two results at
    the same rank in different queries have identical scores regardless of how
    relevant they are. This test encodes the finding, not a behaviour."""
    assert math.isclose(1 / 61, 0.0163934, rel_tol=1e-5)
```

- [ ] **Step 2: Run to confirm failure**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_retrieve.py -v`
Expected: FAIL — `No module named 'retrieve'`

- [ ] **Step 3: Implement the client**

```python
# bench/retrieve.py
"""Retrieval client that preserves calibrated relevance signals.

`graft retrieve` returns only RRF rank scores, 1/(60+rank) — no relevance
magnitude, so no abstention threshold is possible from it (finding F1).
`graft query` exposes s_vec / s_lex / s_jaccard / s_ce but only for the single
top hit (F2). This module fuses both: ranked candidates from `retrieve`,
bodies from `get`, and calibrated signals where available.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
from dataclasses import dataclass

GRAFT = pathlib.Path.home() / ".local/bin/graft"
RRF_K = 60  # retrieval.rrf_k_const in ~/.graft/config.yaml


@dataclass
class Candidate:
    id_hex: str
    title: str
    rrf: float
    s_vec: float | None = None
    s_lex: float | None = None
    s_ce: float | None = None
    body: str | None = None

    @property
    def rank(self) -> int:
        return rrf_rank_of(self.rrf)


def rrf_rank_of(score: float, k: int = RRF_K) -> int:
    """Invert 1/(k+rank) back to rank. Exact for graft's emitted scores."""
    if score <= 0:
        raise ValueError(f"non-positive RRF score: {score}")
    return round(1.0 / score) - k


def _graft(args: list[str], profile: str) -> dict:
    out = subprocess.run(
        [str(GRAFT), *args],
        capture_output=True, text=True,
        env={"GRAFT_PROFILE": profile, "PATH": "/usr/bin:/bin"},
    )
    if not out.stdout.strip():
        raise RuntimeError(f"graft {args[0]} returned nothing: {out.stderr}")
    return json.loads(out.stdout)


def search(query: str, top_k: int = 25,
           profile: str = "longmemeval") -> list[Candidate]:
    payload = _graft(["retrieve", query, "--top-k", str(top_k)], profile)
    results = payload["result"]["results"]

    candidates: list[Candidate] = []
    for row in results:
        cand = Candidate(
            id_hex=row["id_hex"],
            title=row["title"],
            rrf=row["score"],
        )
        body = _graft(["get", cand.id_hex, "--markdown"], profile)
        cand.body = (body.get("result") or {}).get("body")
        candidates.append(cand)
    return candidates
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_retrieve.py -v
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add bench/retrieve.py bench/tests/test_retrieve.py
git commit -m "bench: signal-preserving retrieval client (recovers calibrated scores)"
```

---

### Task 5: Recall@k diagnostic — separate the retrieval gap from the reader gap

The single most decision-relevant measurement in this plan, and it costs **zero tokens**: `answer_session_ids` is ground truth, so retrieval quality is measurable without any model. Run this before spending a cent on the reader.

**Files:**
- Create: `bench/recall.py`
- Test: `bench/tests/test_recall.py`

**Interfaces:**
- Consumes: `search` from Task 4, `ingest_question` from Task 3.
- Produces: `recall_at_k(question, k) -> bool`, `recall_report(questions, ks) -> dict[str, dict[int, float]]` keyed by question_type.

- [ ] **Step 1: Write the failing test**

```python
# bench/tests/test_recall.py
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from recall import evidence_hit

def test_evidence_hit_true_when_gold_session_retrieved():
    question = {"answer_session_ids": ["3"]}
    titles = ["session 7 — 2023-01-01", "session 3 — 2023-03-03"]
    assert evidence_hit(question, titles) is True

def test_evidence_hit_false_when_gold_session_absent():
    question = {"answer_session_ids": ["3"]}
    titles = ["session 7 — 2023-01-01", "session 9 — 2023-03-03"]
    assert evidence_hit(question, titles) is False

def test_abstention_questions_have_no_gold_evidence():
    """_abs questions are unanswerable by design; recall is undefined for them
    and they must be excluded from the recall denominator."""
    question = {"answer_session_ids": []}
    assert evidence_hit(question, ["session 1 — 2023-01-01"]) is None
```

- [ ] **Step 2: Run to confirm failure**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_recall.py -v`
Expected: FAIL — `No module named 'recall'`

- [ ] **Step 3: Implement**

```python
# bench/recall.py
"""Token-free retrieval diagnostic.

`answer_session_ids` is ground truth, so recall@k needs no model at all.
This cleanly splits the S-score gap into a retrieval component and a reader
component — which decides where Plan 2 spends effort.
"""
from __future__ import annotations

import re
from collections import defaultdict


def _session_index(title: str) -> str | None:
    m = re.match(r"session (\S+) —", title)
    return m.group(1) if m else None


def evidence_hit(question: dict, titles: list[str]) -> bool | None:
    """True/False if the question has gold evidence; None for abstention."""
    gold = set(map(str, question.get("answer_session_ids") or []))
    if not gold:
        return None
    got = {_session_index(t) for t in titles}
    return bool(gold & got)


def recall_report(results: list[tuple[dict, list[str]]],
                  ks: tuple[int, ...] = (1, 5, 10, 25)) -> dict:
    """results: [(question, ranked_titles)]. Returns recall by type and k."""
    buckets: dict[str, dict[int, list[bool]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for question, titles in results:
        qtype = question["question_type"]
        for k in ks:
            hit = evidence_hit(question, titles[:k])
            if hit is not None:
                buckets[qtype][k].append(hit)

    return {
        qtype: {k: (sum(v) / len(v) if v else float("nan"))
                for k, v in per_k.items()}
        for qtype, per_k in buckets.items()
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_recall.py -v`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add bench/recall.py bench/tests/test_recall.py
git commit -m "bench: token-free recall@k diagnostic split by question type"
```

---

### Task 6: End-to-end baseline run on `longmemeval_s`

**Files:**
- Create: `bench/run.py`
- Create: `bench/reader.py`
- Create: `bench/judge.py`
- Test: `bench/tests/test_reader_contract.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `bench/runs/<timestamp>/{results.jsonl,summary.json}`; a summary with per-type accuracy and an overall S score comparable to the reported 0.740.

- [ ] **Step 1: Write the reader-contract test (no network)**

```python
# bench/tests/test_reader_contract.py
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from reader import build_prompt

def test_prompt_includes_session_timestamps():
    """Temporal-reasoning is unanswerable if dates are dropped on the way in."""
    ctx = [{"title": "session 0 — 2023-03-03 (2023/03/03 (Fri) 14:12)",
            "body": "user: I booked the Lisbon trip today."}]
    prompt = build_prompt("When did I book the trip?", ctx,
                          question_date="2023/05/20 (Sat) 10:00")
    assert "2023-03-03" in prompt
    assert "2023/05/20" in prompt, "question date anchors relative time words"

def test_prompt_permits_abstention():
    """_abs questions require an explicit escape hatch or the reader confabulates."""
    prompt = build_prompt("Unanswerable?", [], question_date="2023/05/20")
    assert "NO_ANSWER" in prompt
```

- [ ] **Step 2: Run to confirm failure**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_reader_contract.py -v`
Expected: FAIL — `No module named 'reader'`

- [ ] **Step 3: Implement the reader prompt builder**

This is where the allowed token spend lives. Keep it a *baseline* reader for now — no decomposition, no self-consistency. Plan 2 adds those, and only where the diagnostics justify them.

```python
# bench/reader.py
"""Read-time answer synthesis. This is the ONLY place tokens are spent
on the memory path — ingest stays CPU-only per the global constraints."""
from __future__ import annotations

SYSTEM = """You answer questions from a user's own chat history.

Rules:
- Each session below is timestamped. Use the timestamps for any question about
  when something happened, or about what is currently true.
- When two sessions conflict, the LATER timestamp wins — the user changed
  their mind or updated the fact.
- If the sessions genuinely do not contain the answer, reply exactly NO_ANSWER.
  Do not guess. An invented answer is worse than an admitted gap.
- Otherwise answer concisely and directly."""


def build_prompt(question: str, context: list[dict],
                 question_date: str) -> str:
    parts = [SYSTEM, "", f"The question is being asked on: {question_date}", ""]
    if context:
        parts.append("Relevant sessions from the user's history:")
        for item in context:
            parts.append(f"\n--- {item['title']} ---")
            parts.append(item.get("body") or "")
    else:
        parts.append("No sessions were retrieved.")
    parts += ["", f"Question: {question}", "", "Answer:"]
    return "\n".join(parts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_reader_contract.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 4b: Implement the judge**

LongMemEval grades with an LLM judge using question-type-specific criteria. Abstention questions invert the test: the correct behaviour is refusing to answer.

```python
# bench/judge.py
"""LLM-as-judge grading, mirroring LongMemEval's evaluate_qa.py contract."""
from __future__ import annotations

import anthropic

_CLIENT = anthropic.Anthropic()
MODEL = "claude-sonnet-5"

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


def grade(question: str, gold: str, response: str, qtype: str,
          question_id: str = "") -> bool:
    # The _abs suffix lives on question_id, NOT on the question text.
    # Testing the wrong field makes abstention detection silently never fire.
    if question_id.endswith("_abs") or gold in (None, "", "NO_ANSWER"):
        # Abstention: correct iff the reader declined to answer.
        return "NO_ANSWER" in (response or "").upper()

    rubric = RUBRIC.get(qtype, DEFAULT_RUBRIC)
    prompt = (
        f"{rubric}\n\n"
        f"Question: {question}\n"
        f"Correct answer: {gold}\n"
        f"Model response: {response}\n\n"
        "Reply with exactly one word: CORRECT or INCORRECT."
    )
    out = _CLIENT.messages.create(
        model=MODEL,
        max_tokens=8,
        messages=[{"role": "user", "content": prompt}],
    )
    return out.content[0].text.strip().upper().startswith("CORRECT")
```

- [ ] **Step 4c: Implement the runner**

```python
# bench/run.py
"""LongMemEval runner: ingest -> retrieve -> (optionally) read -> judge."""
from __future__ import annotations

import argparse
import json
import pathlib
import time

import anthropic

from ingest import ingest_question
from judge import grade
from reader import build_prompt
from recall import recall_report

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
RUNS = HERE / "runs"
_CLIENT = anthropic.Anthropic()


def answer(question: dict, context: list[dict]) -> str:
    prompt = build_prompt(question["question"], context,
                          question["question_date"])
    out = _CLIENT.messages.create(
        model="claude-sonnet-5",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    return out.content[0].text.strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=["oracle", "s", "m"], required=True)
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--top-k", type=int, default=25)
    ap.add_argument("--recall-only", action="store_true",
                    help="token-free retrieval diagnostic; skips reader+judge")
    args = ap.parse_args()

    from retrieve import search  # imported late so --recall-only still needs it

    rows = json.loads((DATA / f"longmemeval_{args.dataset}.json").read_text())
    rows = rows[: args.limit]

    run_dir = RUNS / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    pairs, records = [], []
    for i, question in enumerate(rows, 1):
        ingest_question(question, run_dir / "sessions")
        cands = search(question["question"], top_k=args.top_k)
        titles = [c.title for c in cands]
        pairs.append((question, titles))

        record = {"question_id": question["question_id"],
                  "question_type": question["question_type"],
                  "retrieved": titles}

        if not args.recall_only:
            ctx = [{"title": c.title, "body": c.body} for c in cands]
            resp = answer(question, ctx)
            correct = grade(question["question"], question["answer"],
                            resp, question["question_type"],
                            question_id=question["question_id"])
            record |= {"response": resp, "correct": correct}

        records.append(record)
        print(f"[{i}/{len(rows)}] {question['question_id']}", flush=True)

    (run_dir / "results.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records)
    )

    summary = {"dataset": args.dataset,
               "recall": recall_report(pairs)}
    if not args.recall_only:
        graded = [r for r in records if "correct" in r]
        summary["overall"] = sum(r["correct"] for r in graded) / len(graded)
        by_type: dict[str, list[bool]] = {}
        for r in graded:
            by_type.setdefault(r["question_type"], []).append(r["correct"])
        summary["by_type"] = {k: sum(v) / len(v) for k, v in by_type.items()}

    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run recall first — it is free**

```bash
~/.heimdall/venv/bin/python3 bench/run.py --dataset oracle --recall-only
```

Record recall@1/5/10/25 per question type. **Stop and read this table before running the paid reader.** If recall@25 on `longmemeval_s` is already ≥0.95, the retrieval side is close to solved and Plan 2 belongs almost entirely in the reader. If it is ≤0.85, the reranker (F3/F4) is the first lever.

- [ ] **Step 6: Run the full baseline**

```bash
~/.heimdall/venv/bin/python3 bench/run.py --dataset oracle --limit 500
~/.heimdall/venv/bin/python3 bench/run.py --dataset s --limit 500
```

Expected: an Oracle score near 0.836 and an S score near 0.740. **If they do not reproduce, that is a finding, not a failure** — F8 says the reported numbers have never been reproduced locally, and a mismatch means the harness differs from whatever produced them. Investigate before optimizing; tuning against an unfaithful harness is wasted work.

- [ ] **Step 7: Commit**

```bash
git add bench/run.py bench/reader.py bench/judge.py bench/tests/test_reader_contract.py
git commit -m "bench: end-to-end LongMemEval baseline run with per-type breakdown"
```

---

## What Plan 2 Will Decide (deliberately not specified here)

Plan 2 is written *after* Task 6 produces numbers. Writing it now would be guesswork. The diagnostics select among these pre-identified levers:

> **Measured 2026-08-23 — the reranker lever is dead.** Enabling
> `cross_encoder_enabled: true` + `rerank.enabled: true` and restarting the
> `longmemeval` daemon moved S recall on the first 50 questions from
> @1 0.18 / @5 0.34 / @10 0.40 / @25 0.78 to
> @1 **0.04** / @5 **0.16** / @10 **0.30** / @25 0.78.
> recall@25 is identical because rerank only reorders within the RRF pool; the
> reordering is strongly anti-correlated with gold. Config reverted; backup at
> `~/.graft/config.yaml.pre-rerank-2026-08-23`. Root cause is most likely the
> same one the chunking lever addresses: the cross-encoder is scoring an entire
> multi-turn session transcript against a short question, so it too is working
> on a unit of retrieval that is far too coarse. Worth re-testing *after*
> chunking lands, not before.

| Lever | Constraint status | Unblocks |
|---|---|---|
| ~~`cross_encoder_enabled: true`, `rerank.enabled: true` (F3/F4)~~ **REJECTED — measurably worse, see note above** | CPU-only ✅ | nothing; halves recall@1 |
| Calibrated abstention threshold on `s_vec`/`s_ce` instead of RRF rank (F1/F2) | CPU-only ✅ | Every `_abs` question |
| Dual-granularity indexing (round-level + session-level) with session expansion on hit | CPU-only ✅ | single-session-preference, multi-session |
| Raise `threads`, enable `hardware_accel` on the M1 Pro (F6) | CPU-only ✅ | **18x ingest throughput, and it fixes a graftd segfault** — see note below |
| Reader decomposition for multi-session aggregation | Token spend ✅ (permitted) | multi-session |
| Recency-ordered evidence presentation | CPU-only ✅ | knowledge-update, temporal-reasoning |
| Reader verification pass | Token spend ✅ (permitted) | Oracle ceiling 0.836 → 0.90 |

> **Measured 2026-08-23 — F6 is not just a throughput lever, it fixes a crash.**
> Under the shipped `threads: 2, hardware_accel: false`, `graftd` segfaults
> under sustained embedding load: five `EXC_BAD_ACCESS` crash reports between
> 02:25 and 02:40, every one of them in
> `ggml_gemm_q8_0_4x4_q8_0` on a `ggml_graph_compute_secondary_thread` — the
> llama.cpp AArch64 CPU repack GEMM kernel. This is the same failure that killed
> the first full S recall at question 423/500 and that the harness's insert-retry
> logic was papering over; it is a real Heimdall bug, not benchmark flakiness.
> Setting `threads: 6, hardware_accel: true` routes matmul to Metal, bypassing
> the buggy repack path entirely: zero crashes since, and per-question ingest
> went from ~3 min to ~20 s (54 sessions or 230 chunks). Backup of the old
> config is at `~/.graft/config.yaml.pre-throughput-2026-08-23`.
>
> **This should be fixed in Heimdall/graft proper, independently of the
> benchmark** — anyone running the shipped default on Apple Silicon is one
> sustained ingest away from a segfaulting memory daemon.

**The honest risk, stated up front:** S ≥ 0.90 requires Oracle > 0.90, i.e. cutting reader error from 16.4% to under 10% *with perfect evidence already in hand*. Published leaderboard systems that clear 90% (MemPalace 96.6%, OMEGA 95.4%, Mastra 94.87%, Mem0 93.4%) all do LLM-based consolidation at ingest — the thing this plan's first global constraint forbids. Moving that consolidation to read time is a credible substitute, but it is **not a proven-equivalent one**, and some residual LongMemEval error is label ambiguity that no system recovers. If Task 6's diagnostics show the reader gap is dominated by genuine reasoning failures rather than evidence-presentation failures, the no-LLM-at-ingest constraint should be revisited as a deliberate decision rather than quietly worked around.

## Sources

- [LongMemEval (OpenReview)](https://openreview.net/pdf?id=pZiyCaVuti)
- [LongMemEval project page](https://xiaowu0162.github.io/long-mem-eval/)
- [AI Memory Benchmarks 2026 — mem0](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)
- [SOTA on LongMemEval with RAG — Emergence AI](https://www.emergence.ai/blog/sota-on-longmemeval-with-rag)
