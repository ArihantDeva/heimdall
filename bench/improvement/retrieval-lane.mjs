// bench/improvement/retrieval-lane.mjs — accuracy measured on REAL retrieval.
//
// The first version of this lane scored hand-written `ranked` arrays in
// fixtures.mjs. Adversarial review was right to call that out: no product
// module was imported, so the numbers were identical on a tree where the
// entire retrieval path had been deleted. It measured the scoring arithmetic,
// not Heimdall.
//
// This lane builds a real index in a scratch HOME, inserts real documents, asks
// real queries through the SAME code path kb-verify.sh used (embed-index's
// query()), and grades the ranking it returns against gold documents that were
// chosen before the query ran. Hermetic: scratch HOME, scratch DB, no daemon,
// no network, live ~/.heimdall untouched.
//
// Determinism: the embedding model is CPU/offline, and the scratch DB starts
// empty on every run, so a given (docs, queries) pair yields a stable ranking.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { rankingMetrics } from "./eval.mjs";
import { RETRIEVAL_CASE } from "./retrieval-case.mjs";

const KS = [1, 3, 5];

// The embedding model lives in the real user cache. A scratch HOME redirects
// HF_HOME into the scratch dir, where no model exists, so the lane must point
// at the shared read-only cache — otherwise it tries to download (and fails
// offline). Read-only: the cache is never written by these runs.
const HF_CACHE = process.env.HEIMDALL_EVAL_HF_CACHE ?? join(homedir(), ".cache", "huggingface");

/**
 * Run the retrieval case in a scratch index and grade the real ranking.
 * Returns per-query detail so a failure names the query, not just an average.
 */
export function runRetrievalWorkload({ repo, home, python, caseSpec = RETRIEVAL_CASE }) {
  const embed = join(repo, "bin", "embed-index.py");
  const script = buildScript(embed, caseSpec);
  const r = safeExec(
    python,
    ["-c", script],
    {
      HOME: home,
      HEIMDALL_DB: join(home, "db.sqlite"),
      HEIMDALL_HOME: home,
      HF_HOME: HF_CACHE,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    },
  );
  const result = JSON.parse(r.trim().split("\n").pop());
  if (result.error) throw new Error(`retrieval lane failed: ${result.error}`);
  const perQuery = result.queries.map((q) => ({
    id: q.id,
    ranked: q.ranked,
    metrics: rankingMetrics(q.ranked, q.gold, KS),
  }));
  const agg = {};
  for (const key of Object.keys(perQuery[0].metrics)) {
    agg[key] = perQuery.reduce((sum, q) => sum + q.metrics[key], 0) / perQuery.length;
  }
  return { ...agg, n: perQuery.length, perQuery, labels: caseSpec.hash };
}

function safeExec(python, args, env) {
  try {
    return execFileSync(python, args, {
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env, KMP_DUPLICATE_LIB_OK: "TRUE" },
    });
  } catch (e) {
    const detail = String(e.stderr ?? e.message ?? e).trim().slice(-800);
    throw new Error(`retrieval lane could not run: ${detail}`);
  }
}

/** The python program: insert the case's documents, then run its queries. */
function buildScript(embed, caseSpec) {
  const docs = JSON.stringify(caseSpec.docs);
  const queries = JSON.stringify(caseSpec.queries);
  return `
import importlib.util, json, os, pathlib, sys
scratch = pathlib.Path(os.environ["HEIMDALL_HOME"])
sys.path.insert(0, str(pathlib.Path(${JSON.stringify(embed)}).parent))
spec = importlib.util.spec_from_file_location("ei", ${JSON.stringify(embed)})
m = importlib.util.module_from_spec(spec); sys.modules["ei"] = m; spec.loader.exec_module(m)
m._ram_ok = lambda *a, **k: True
docs = json.loads(${JSON.stringify(docs)})
queries = json.loads(${JSON.stringify(queries)})
try:
    for d in docs:
        p = scratch / d["name"]
        p.write_text(d["text"], encoding="utf-8")
        m.insert_card(str(p))
    out = []
    for q in queries:
        hits = m.query(q["text"], n=${KS[KS.length - 1]})
        titles = [h.get("title") for h in hits]
        ranked = [t for t in titles if t]
        out.append({"id": q["id"], "gold": q["gold"], "ranked": ranked})
    print(json.dumps({"queries": out}))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
`;
}
