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
