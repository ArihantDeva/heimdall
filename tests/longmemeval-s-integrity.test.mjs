// LongMemEval-S integrity: the eval must be trustworthy BEFORE anything is
// hill-climbed on it. Every test here is about the eval validity, not retrieval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL = join(REPO, "bench", "longmemeval_s", "eval.py");
const CLIMB = join(REPO, "bench", "longmemeval_s", "climb.py");
const src = readFileSync(EVAL, "utf8");

// Parse the corpus/question tables out of the module without importing it
// (importing pulls in sqlite_vec + sentence_transformers, which the Mac and
// jadupc1 only have inside a venv).
function tables() {
  const files = [...src.matchAll(/^\s{4}"([^"]+\.(?:mjs|py|sh|js|ts))",$/gm)]
    .map((m) => m[1]);
  const qs = [...src.matchAll(/dict\(split="(\w+)", q="([^"]+)",\s*\n\s*gold="([^"]+)"/g)]
    .map((m) => ({ split: m[1], q: m[2], gold: m[3] }));
  return { files, qs };
}

// Split membership is READ FROM eval.py, not hard-coded here. DEV_FILES is
// `CORPUS_FILES[:N]`, so resolve the slice instead of looking for a literal
// list -- an earlier version looked for one, found nothing, and reported
// dev=0 test=0 while still "passing" the disjointness assert.
function splits() {
  const slice = src.match(/DEV_FILES\s*=\s*CORPUS_FILES\[:(\d+)\]/);
  assert.ok(slice, "DEV_FILES is not a CORPUS_FILES slice; update splits()");
  const n = Number(slice[1]);
  const files = [...src.matchAll(/^\s{4}"([^"]+\.(?:mjs|py|sh|js|ts))",\s*$/gm)]
    .map((m) => m[1]);
  return { dev: files.slice(0, n), test: files.slice(n), all: files };
}

test("no file appears in both the dev and test corpus", () => {
  // The single property that makes a dev gain evidence rather than coincidence.
  // A file in both splits can be memorised; a knob that improves dev by
  // memorising a shared file is not a real improvement, and the held-out check
  // cannot see it.
  const { dev, test } = splits();
  const overlap = dev.filter((f) => test.includes(f));
  assert.deepEqual(overlap, [], `files in both splits: ${overlap.join(", ")}`);
  assert.ok(dev.length >= 5 && test.length >= 5,
    `splits too small to be meaningful: dev=${dev.length} test=${test.length}`);
});

test("every question's gold file is in its own split's corpus", () => {
  // A question whose gold is not indexed can never be answered, so it silently
  // caps recall. This bug shipped once already: cli-main.mjs was a DEV file but
  // had a TEST question, so that question was unanswerable by construction.
  const { qs } = tables();
  const { dev, test } = splits();
  assert.ok(dev.length > 0 && test.length > 0, "a split is empty");
  const devSet = new Set(dev);
  const testSet = new Set(test);
  for (const q of qs) {
    const idx = q.split === "dev" ? devSet : testSet;
    assert.ok(idx.has(q.gold),
      `${q.split} question "${q.q}" has gold ${q.gold}, which is not in the ${q.split} corpus`);
  }
});

test("questions are natural language, not keyword soup", () => {
  // The reason this eval exists. The old benchmark's ten queries were extracted
  // from each gold file's own first 3000 characters, so they shared vocabulary
  // with their answers by construction -- five "improvements" moved that score
  // 0.30 -> 0.50 -> 0.30 while held-out recall went 2/5 -> 0/5 -> 1/5.
  // A question must read as a question and must NOT be mostly file tokens.
  const { qs } = tables();
  assert.ok(qs.length >= 20, `only ${qs.length} questions`);
  for (const q of qs) {
    // A real question, not a statement. "How do I rebuild everything" is a
    // genuine question and a perfectly good test; requiring a literal "?" would
    // reject it, so require interrogative form instead.
    const interrogative = /\b(how|what|which|where|when|why|who|does|is|are|can|do)\b/i;
    assert.match(q.q, interrogative,
      `not a question: "${q.q}"`);
    assert.ok(q.q.trim().length >= 20, `too terse to be a real test: "${q.q}"`);
    // A question that names its own answer is worthless as a test. Only the
    // DISTINCTIVE stem counts, and only when the question uses it as a
    // technical term: "where are people recorded" is a fair question about
    // people.mjs, and so is "how does the search script rank results" about
    // kb-search.sh. What would be cheating is a question that names an
    // identifier no human would say -- so ignore stems that are also common
    // English words.
    const COMMON = new Set(["search", "people", "facts", "index", "build", "lock", "main", "build", "rules", "server", "facts"]);
    const base = q.gold.split("/").pop().replace(/\.[^.]+$/, "")
      .split(/[-_.]/).filter((w) => w.length >= 5 && !COMMON.has(w));
    const words = q.q.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, ""));
    const named = base.filter((w) => words.some((x) => x === w || (x.length > 5 && x.includes(w))));
    assert.deepEqual(named, [],
      `question "${q.q}" names its own gold file (${q.gold}) via ${named.join(",")}`);
  }
});

test("the corpus is pinned and never the live index", () => {
  // global.db drifted 402,993 -> 403,000 cards DURING one measurement and moved
  // an identical tree between 0.30 and 0.40. A metric whose input moves under
  // you is not a metric, so the eval builds its own index from a fixed file
  // list and never reads ~/.heimdall.
  assert.ok(src.includes("build_index"), "no index build of its own");
  assert.doesNotMatch(src, /expanduser\(["']~\/\.heimdall["']\)/,
    "the eval reads the live ~/.heimdall index");
  assert.match(src, /CORPUS_FILES/, "no pinned corpus list");
});

test("the hill-climb checks held-out after every dev promotion", () => {
  // Without this the loop can raise dev forever while held-out falls -- exactly
  // what happened in the failed attempt, and nothing noticed.
  const c = readFileSync(CLIMB, "utf8");
  assert.match(c, /heldout_check/, "no held-out re-check recorded");
  const iDev = c.indexOf('"trial"');
  const iHeld = c.indexOf("heldout_check", iDev);
  assert.ok(iDev >= 0 && iHeld > iDev, "held-out check does not follow the trial");
  assert.match(c, /revert/i, "overfit promotions are not reverted");
  assert.match(c, /ledger\.jsonl|LEDGER/, "no audit ledger");
});

test("every trial is written to the ledger, promoted or not", () => {
  const c = readFileSync(CLIMB, "utf8");
  const verdictAt = c.indexOf('"verdict"');
  const logAt = c.indexOf("log({");
  assert.ok(verdictAt > 0 && logAt > 0, "trial or logging missing");
  assert.match(c, /verdict = "PROMOTE" if .* else "reject"/,
    "a trial without a recorded verdict would be unauditable");
});
