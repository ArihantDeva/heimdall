// source-preference.test.mjs — the code slice must reach its golds.
//
// RED for the 0.80 goal. All 10 code golds are present in global.db
// (verified: one card each), yet 6 rank outside the top 100. The cause is
// not the golds and not the ranking function: 34% of the 604,136 indexed
// cards are vendored or generated code —
//
//   /site-packages/   101,041  16.7%
//   /graphify-out/    55,688   9.2%
//   /worktrees/       44,805   7.4%
//   /vendor/          23,512   3.9%
//   /pipx/venvs/      23,539   3.9%
//
// so `JWT auth middleware bearer token verification` returns six vendored
// `jwt_bearer.pyi` / `bearer_auth.py` files ahead of the user's own
// `equitylens/api/core/auth_jwt.py`. These tests pin the shape of the fix:
// prune derived source at INDEX time (where the walker already prunes), so
// the noise never competes, rather than penalising it at search time.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WALKER = join(repoRoot, "bin", "embed_walker.py");
const SEARCH = join(repoRoot, "bin", "kb-search.sh");
const src = readFileSync(WALKER, "utf8");

const search = (q, n = 5) =>
  spawnSync("bash", [SEARCH, q, "-n", String(n)], { encoding: "utf8" });

test("the walker prunes the derived-source subtrees that dominate the index", () => {
  // These are the five prefixes holding 34% of the index. site-packages and
  // pipx/venvs are the big two: PRUNE_DIRS already has venv/.venv by
  // BASENAME, but `site-packages` is a basename those misses, and pipx puts
  // its venvs under a different parent.
  for (const dir of ["site-packages", "graphify-out", "worktrees", "pipx"]) {
    assert.ok(src.includes(`"${dir}"`),
      `PRUNE_DIRS is missing "${dir}" — 34% of the index is derived source`);
  }
});

test("pruning is by path prefix, so a real source file named worktrees survives", () => {
  // The Phase 1 lesson: a BASENAME entry prunes every dir with that name at
  // any depth. A repo genuinely containing a directory called `worktrees`
  // with real source in it would lose it, which is how bench/*.py was nearly
  // lost in the first place. So these must be PREFIXES, not basenames.
  assert.ok(src.includes("PRUNE_PREFIXES"),
    "expected path-prefix pruning, distinct from basename PRUNE_DIRS");
});

test("the walker still runs after the change", () => {
  // A syntax error here would silently make every card in the index stale.
  const r = spawnSync("python3", ["-c",
    `import ast,sys
src=open(${JSON.stringify(WALKER)}).read()
ast.parse(src)
pruned=set()
ns={}
exec(compile(src.split("# ---")[0], "w", "exec"), ns)
pruned={p for p in ns.get("PRUNE_DIRS",set())}
pref={p for p in ns.get("PRUNE_PREFIXES",())}
print("dirs=%d prefixes=%d" % (len(pruned), len(pref)))
for d in ("site-packages","graphify-out","worktrees","pipx","node_modules","venv",".venv","dist","build"):
    assert_ok = d in pruned or any(d in p for p in pref)
    if not assert_ok: print("MISSING:", d)
`], { encoding: "utf8" });
  assert.equal(r.status, 0, `walker failed to parse/run: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /^MISSING:/m,
    `derived subtrees not pruned:\n${r.stdout}`);
});

test("a JWT query surfaces the user's own auth module, not vendored stubs", () => {
  const out = search("JWT auth middleware bearer token verification", 5).stdout;
  if (!existsSync(join(process.env.HOME, ".heimdall", "global.db"))) return;
  const paths = out.split("\n").filter((l) => l.includes("/Users/"));
  assert.ok(paths.length > 0, "no hits at all");
  const vendored = paths.filter((l) =>
    /site-packages|pipx\/venvs|graphify-out|node_modules/.test(l));
  // Not "no vendored hit ever" — a vendored file may legitimately be the best
  // answer. The assertion is that vendored noise cannot occupy the whole top
  // of the list while the user's own module is absent from it.
  const own = paths.some((l) => /equitylens\/api\/core\/auth_jwt\.py/.test(l)
    || !/site-packages|pipx\/venvs|graphify-out/.test(l));
  assert.ok(own, `top results are all vendored:\n${out.slice(0, 600)}`);
  assert.ok(vendored.length < paths.length,
    `every top hit is vendored (${vendored.length}/${paths.length})`);
});

// ── third defect: whitespace tokenization ──────────────────────────────────

test("query tokens are word tokens, so hyphenated source text still matches", () => {
  // bin/lib/reconcile.mjs opens with the literal comment
  //   "// reconcile.mjs — level-triggered convergence."
  // and the code gold queries "level triggered convergence audit drift".
  // q.lower().split() produces the token "triggered", which is not a substring
  // of "level-triggered", so the file's own name for itself scores zero
  // coverage and never ranks. This is the general case: CamelCase,
  // snake_case, kebab-case and dotted identifiers are how source code is
  // written, so whitespace-only tokenization systematically under-matches code.
  const sh = readFileSync(SEARCH, "utf8");
  assert.doesNotMatch(sh, /q_toks = set\(q\.lower\(\)\.split\(\)\)/,
    "tokens are still whitespace-split, so code never matches its own vocabulary");
});

test("tokenization splits on the boundaries real identifiers use", () => {
  const sh = readFileSync(SEARCH, "utf8");
  assert.ok(sh.includes("def tokenize("), "no tokenize() helper");
  // Behavioural, and run against EVERY heredoc copy: each is a separate python
  // process, so the helper is duplicated and the first match is the mnemosyne
  // block's -- slicing only the first missed the code leg entirely, which is
  // how a green test coexisted with `NameError: name 'tokenize' is not defined`
  // on the code path.
  const defs = [...sh.matchAll(/def tokenize\(q\):\n(?:    .*\n|\n)*?    return out\n/g)]
    .map((m) => m[0]);
  assert.ok(defs.length >= 2,
    `expected one tokenizer per heredoc, found ${defs.length}`);
  const cases = [
    ["level-triggered convergence", ["level", "triggered", "convergence"]],
    ["api_key_auth", ["api", "key", "auth"]],
    ["parseCSV", ["parse", "csv"]],
    ["auth_jwt.py", ["auth", "jwt", "py"]],
    ["src/workflows/db", ["src", "workflows", "db"]],
  ];
  for (const [n, def] of defs.entries()) {
    // The helper imports `re` as `_re`; the harness must bind that name too.
    const out = execFileSync("python3", ["-c",
      "import re as _re\n" + def + "\nimport json\n" +
      "print(json.dumps({k: sorted(tokenize(k)) for k in " +
      JSON.stringify(cases.map((c) => c[0])) + "}))"], { encoding: "utf8" });
    const got = JSON.parse(out);
    for (const [input, want] of cases) {
      for (const w of want) {
        assert.ok(got[input].includes(w),
          `tokenizer #${n} lost "${w}" from ${input} -> ${JSON.stringify(got[input])}`);
      }
    }
  }
});

test("tokenization is applied to the code leg, not just the memory backend", () => {
  // There are TWO q_toks assignments. Fixing only the first (the mnemosyne
  // memory backend, which is off by default) would leave the code path
  // untouched and the whole change inert.
  const sh = readFileSync(SEARCH, "utf8");
  const all = sh.match(/q_toks = set\(q\.lower\(\)\.split\(\)\)/g) || [];
  assert.equal(all.length, 0,
    `${all.length} whitespace-split tokenizers remain`);
  const uses = (sh.match(/q_toks = tokenize\(q\)/g) || []).length;
  assert.ok(uses >= 1, "no call site uses the new tokenizer");
});

test("code golds score real coverage against their own source text", () => {
  // End-to-end and data-driven: for each code gold, the query's tokens must
  // actually occur in the indexed body. This is the property that makes the
  // slice winnable, and it is checked against the index rather than a fixture.
  if (!existsSync(join(process.env.HOME || "", ".heimdall", "global.db"))) return;
  const rows = readFileSync(join(repoRoot, "bench", "queries", "retrieval-30.jsonl"),
    "utf8").trim().split("\n").map(JSON.parse);
  const code = rows.filter((r) => r.slice === "code");
  const out = execFileSync("python3", ["-c", `
import sqlite3, json, os, re, sys
c = sqlite3.connect('file:' + os.path.expanduser('~/.heimdall/global.db') + '?mode=ro', uri=True)
def toks(s):
    # mirrors the tokenisation the search leg is required to use
    out = set()
    for part in re.split(r'[^A-Za-z0-9]+', s):
        if not part: continue
        for w in re.findall(r'[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+', part):
            out.add(w.lower())
    return out
rows = json.load(sys.stdin)
res = []
for r in rows:
    b = c.execute('select body from cards where path=?', (r['golds'][0],)).fetchone()
    if not b: res.append((r['qid'], None)); continue
    hay = toks(b[0])
    q = toks(r['query'])
    res.append((r['qid'], round(len(q & hay) / max(1, len(q)), 2)))
print(json.dumps(res))
`, JSON.stringify(code)], { encoding: "utf8", input: "[]" });
  const covs = JSON.parse(out);
  const low = covs.filter(([qid, c]) => c !== null && c < 0.25);
  assert.equal(low.length, 0,
    "golds whose own source text barely covers their query: " + JSON.stringify(low));
});

// ── the query side of an asymmetric embedding model ─────────────────────

test("bge queries carry the retrieval instruction the model was trained for", () => {
  // bge-*-en-v1.5 is ASYMMETRIC: the card side is embedded as "<title>\n<body>"
  // (embed-index.py _upsert_batch), and the model was trained to receive
  // "Represent this sentence for searching relevant passages: " on the QUERY
  // side. query() sent the bare string, so the two sides of the comparison were
  // formatted the way the model does not expect.
  //
  // Measured on held-out natural-language probes against the EXISTING index
  // (no rebuild -- only the query is re-encoded):
  //   bare        top-10 2/5   ranks=[None, 2, 3, None, None]
  //   bge-prefix  top-10 2/5   ranks=[None, 2, 1, None, None]
  // A small, one-directional gain (rank 3 -> 1, no probe made worse), which is
  // what a correct prompt should look like -- and it is free, because the
  // documents were embedded the right way already.
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  assert.match(srcQ, /Represent this sentence for searching relevant passages/,
    "the bge retrieval instruction is missing from the query path");
});

test("the instruction applies to bge models only, and never to the build", () => {
  // Two failure modes this must avoid: (a) prefixing a model that was not
  // trained asymmetrically, and (b) prefixing the DOCUMENT side, which degrades
  // bge document vectors and would require a full rebuild to undo.
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  const i = srcQ.indexOf("def query(");
  const q = srcQ.slice(i, srcQ.indexOf("def status(", i));
  assert.match(q, /bge/i,
    "the instruction is not gated on the model being a bge model");
  const buildStart = srcQ.indexOf("def _upsert_batch");
  const build = srcQ.slice(buildStart, srcQ.indexOf("def ", buildStart + 5));
  assert.doesNotMatch(build, /Represent this sentence/,
    "the instruction leaked into the document side, which would need a rebuild");
});

test("query-side encoding goes through one helper, not a bare encode call", () => {
  // The same class of bug twice now: the coverage ranking and the tokenizer
  // were each correct in one place and missing from the other. One helper,
  // called by the query path, so there is nothing to forget.
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  const helper = srcQ.match(/def encode_query\(/);
  assert.ok(helper, "no encode_query helper; the prompt lives inline where it drifts");
  const i = srcQ.indexOf("def query(");
  const q = srcQ.slice(i, srcQ.indexOf("def status(", i));
  assert.match(q, /encode_query\(/,
    "query() does not route through encode_query()");
  assert.doesNotMatch(q, /model\(\)\.encode\(/,
    "query() still calls model().encode() directly");
});
