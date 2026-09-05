// kb-search-guard — RED suite. Contract (from goal):
// 1. warn on the 3rd consecutive grep-style action, and on EVERY further grep action after that
// 2. never warn for chains of 2 or fewer
// 3. chain resets on kb_search / kb_sync / graft-call
// 4. interleaved read tool calls do NOT reset the chain
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuard, GREP_TOOLS, RESET_TOOLS } from "../extensions/lib/kb-guard-core.mjs";

const t = (name, fn) => test(name, fn);

t("contract: every grep tool is classified", () => {
  assert.deepEqual([...GREP_TOOLS].sort(), ["bash", "find", "grep", "ls", "read"]);
});

t("contract: reset tools classified", () => {
  assert.ok(RESET_TOOLS.has("kb_search"));
  assert.ok(RESET_TOOLS.has("kb_sync"));
});

t("REQ1: warns on 3rd consecutive grep action", () => {
  const g = createGuard();
  assert.equal(g.note("read", {}), null);
  assert.equal(g.note("grep", {}), null);
  const third = g.note("ls", {});
  assert.ok(third && third.includes("kb_search"));
});

t("REQ1b: warns on EVERY further grep action after 3rd", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("grep", {});
  g.note("ls", {});
  assert.ok(g.note("bash", {}));
  assert.ok(g.note("find", {}));
  assert.ok(g.note("read", {}));
});

t("REQ2: never warns for chains of 2 or fewer", () => {
  const g = createGuard();
  assert.equal(g.note("read", {}), null);
  assert.equal(g.note("grep", {}), null); // exactly 2: still no warning
  // (3rd fires — covered by REQ1)
});

t("REQ2b: reset then exactly 2 again = no warning", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  g.note("read", {});
  g.note("kb_search", {});
  assert.equal(g.note("read", {}), null);
  assert.equal(g.note("bash", {}), null);
});

t("REQ3: kb_search resets the chain", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {});
  assert.ok(w);
  assert.equal(g.note("kb_search", {}), null); // reset signal
  assert.equal(g.note("read", {}), null);
  g.note("read", {});
  assert.ok(g.note("read", {})); // chain restarted, hits 3 again
});

t("REQ3b: kb_sync also resets", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  g.note("read", {});
  assert.equal(g.note("kb_sync", {}), null);
  assert.equal(g.note("grep", {}), null);
});

t("REQ4: interleaved non-grep tool calls do NOT reset", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("edit", {});
  g.note("grep", {});
  assert.ok(g.note("find", {})); // 3rd grep-style despite edit between
});

t("warn message names the guard + asks kb_search", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {});
  assert.ok(w.includes("kb_search"));
  assert.ok(w.toLowerCase().includes("warning") || w.includes("⚠️"));
});

t("state is per-guard instance (per-session isolation)", () => {
  const a = createGuard();
  const b = createGuard();
  a.note("read", {});
  a.note("read", {});
  a.note("read", {});
  assert.equal(b.note("read", {}), null);
  assert.ok(a.note("read", {}));
});

// ── Block ladder (2026-08-25): firing 1 warn → firing 2 escalate → firing 3+ block ──

function blockReady() {
  const g = createGuard();
  for (let i = 0; i < 6; i++) g.note("read", {}); // firings 1+2 (warn, escalate) + chain past 3
  return g;
}

t("BLOCK1: firing 1 is a warning string", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {});
  assert.equal(typeof w, "string");
  assert.ok(w.includes("⚠️"));
});

t("BLOCK2: firing 2 is an escalation string", () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) g.note("read", {}); // firing 1
  const w = g.note("read", {}); // firing 2
  assert.equal(typeof w, "string");
  assert.ok(w.includes("🛑"));
});

t("BLOCK3: firing 3 blocks a search TOOL call", () => {
  const g = blockReady();
  const v = g.note("find", {});
  assert.ok(v && typeof v === "object");
  assert.equal(v.block, true);
  assert.ok(v.reason.includes("kb_search"));
});

t("BLOCK4: firing 3+ blocks pathless rg-headed bash, not scoped bash or non-search bash", () => {
  const g = blockReady();
  // non-search bash passes even at block stage
  assert.equal(g.note("bash", { command: "npm test" }), null);
  assert.equal(g.note("bash", { command: "git status --short" }), null);
  // scoped (path-bearing) bash passes even at block stage — legitimate work
  assert.equal(g.note("bash", { command: "rg pattern src/" }), null);
  // pathless rg-headed bash IS blocked
  const v = g.note("bash", { command: "rg pattern" });
  assert.ok(v && typeof v === "object");
  assert.equal(v.block, true);
});

t("BLOCK8: pathless search binary anywhere in pipe/chain segment is blockable", () => {
  const g = blockReady();
  assert.equal(g.note("bash", { command: "cat x | grep -rn foo" }).block, true); // grep pathless
  assert.equal(g.note("bash", { command: "echo hi && ls -la" }).block, true);
  assert.equal(g.note("bash", { command: "rg foo | head -3" }).block, true);
  assert.equal(g.note("bash", { command: "npm test 2>&1 | tail -5" }), null); // no search head
});

t("BLOCK7: graft/heimdall bash prefix still resets", () => {
  const g = createGuard();
  for (let i = 0; i < 7; i++) g.note("read", {});
  assert.equal(g.note("bash", { command: "graft status" }), null);
  assert.equal(g.note("bash", { command: "heimdall doctor" }), null);
});

t("BLOCK5: pathless grep/ls/find-headed bash blocked too", () => {
  const g = blockReady();
  assert.equal(g.note("bash", { command: "/usr/bin/grep -rn x" }).block, true);
  assert.equal(g.note("bash", { command: "ls -la" }).block, true);
  assert.equal(g.note("bash", { command: "find -maxdepth 1 -name y" }).block, true);
});

t("BLOCK6: kb_search reset clears block state", () => {
  const g = createGuard();
  for (let i = 0; i < 7; i++) g.note("read", {});
  assert.equal(g.note("kb_search", {}), null);
  assert.equal(g.note("read", {}), null); // fresh chain — no warning, no block
});

t("BLOCK10: kb_sync reset clears block state identically", () => {
  const g = createGuard();
  for (let i = 0; i < 7; i++) g.note("read", {});
  assert.equal(g.note("kb_sync", {}), null); // reset signal
  assert.equal(g.note("find", {}), null); // fresh chain — no warning, no block
  g.note("read", {});
  const w = g.note("read", {}); // chain back at 3 → firing 1 again
  assert.equal(typeof w, "string");
  assert.ok(w.includes("⚠️")); // ladder restarted from warn, not block
});

t("BLOCK9: non-search bash at block stage neither fires nor advances chain", () => {
  const g = blockReady();
  assert.equal(g.note("bash", { command: "npm test" }), null);
  assert.equal(g.chain, 6); // unchanged — chain counts search actions only
});

// ── Pause/suspend (2026-08-25): agent-callable temporary disable for N turns ──

t("PAUSE1: suspend silences warnings entirely", () => {
  const g = createGuard();
  assert.equal(g.suspend(2), 2);
  g.note("read", {});
  g.note("read", {});
  assert.equal(g.note("read", {}), null);
  assert.equal(g.note("grep", {}), null);
});

t("PAUSE2: suspend prevents blocks even from a pre-fired ladder", () => {
  const g = blockReady();
  assert.equal(g.suspend(3), 3);
  assert.equal(g.note("find", {}), null);
  assert.equal(g.note("bash", { command: "ls -la" }), null);
  assert.equal(g.note("bash", { command: "rg x ." }), null);
});

t("PAUSE3: turns above 20 clamp to 20", () => {
  const g = createGuard();
  assert.equal(g.suspend(500), 20);
  assert.equal(g.pausedTurns, 20);
});

t("PAUSE4: non-positive/non-numeric turns rejected, fractions floored", () => {
  const g = createGuard();
  assert.equal(g.suspend(0), 0);
  assert.equal(g.suspend(-3), 0);
  assert.equal(g.suspend("abc"), 0);
  assert.equal(g.suspend(NaN), 0);
  assert.equal(g.suspend(2.9), 2);
  assert.equal(g.pausedTurns, 2);
});

t("PAUSE5: expiry via tickTurn restores enforcement from clean slate", () => {
  const g = createGuard();
  g.suspend(1);
  g.note("read", {});
  g.note("read", {});
  g.tickTurn(); // pause over
  assert.equal(g.pausedTurns, 0);
  assert.equal(g.chain, 0);
  assert.equal(g.firings, 0);
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {}); // 3rd since expiry → firing 1 = warn, ladder restarted
  assert.equal(typeof w, "string"); // warn again — ladder restarted, not block
  assert.ok(w.includes("⚠️"));
});

t("PAUSE6: tickTurn is inert when not paused", () => {
  const g = createGuard();
  g.tickTurn();
  g.note("read", {});
  g.note("read", {});
  assert.equal(typeof g.note("read", {}), "string");
});

t("PAUSE7: re-suspend extends rather than shrinks", () => {
  const g = createGuard();
  g.suspend(10);
  g.suspend(2);
  assert.equal(g.pausedTurns, 10);
  g.suspend(15);
  assert.equal(g.pausedTurns, 15);
});

// ── Scope-aware firing (2026-08-27): scoped/known-path searches never warn; only unscoped discovery chains do ──

t("SCOPE1: scoped repo search chain never warns", () => {
  const g = createGuard();
  // bash with explicit repo dir + scoped rg
  assert.equal(g.note("bash", { command: "cd ~/Repos/heimdall && rg --no-ignore -n foo src/" }), null);
  // read of a known file path
  assert.equal(g.note("read", { path: "/Users/arihantdeva/Repos/heimdall/tests/guard.test.mjs" }), null);
  // fd scoped to a repo
  assert.equal(g.note("bash", { command: "fd -e ts tests" }), null);
  // 4+ scoped actions — still no warning
  assert.equal(g.note("read", { path: "/Users/arihantdeva/Repos/heimdall/extensions/kb-search-guard.ts" }), null);
});

t("SCOPE2: scoped find with explicit dir never warns", () => {
  const g = createGuard();
  assert.equal(g.note("bash", { command: "find /Users/arihantdeva/Repos/heimdall -name '*.ts'" }), null);
  assert.equal(g.note("bash", { command: "find ~/Repos/heimdall -name '*.mjs'" }), null);
  assert.equal(g.note("bash", { command: "find . -name '*.ts'" }), null); // relative cwd-scoped
});

t("SCOPE3: unscoped discovery chain still warns at 3 and escalates at 4", () => {
  const g = createGuard();
  assert.equal(g.note("bash", { command: "ls" }), null);
  assert.equal(g.note("bash", { command: "find -type d" }), null); // pathless
  const w = g.note("bash", { command: "rg --no-ignore foo" }); // 3rd pathless — warn
  assert.ok(w && w.includes("⚠️"));
  const esc = g.note("bash", { command: "grep -rn bar" }); // 4th — escalate
  assert.ok(esc && esc.includes("🛑"));
});

t("SCOPE4: unscoped read (no path) still counts; scoped read does not", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {}); // 3rd unscoped read — warn
  assert.ok(w && w.includes("⚠️"));
  const g2 = createGuard();
  g2.note("read", { path: "/a/b.ts" });
  g2.note("read", { path: "/a/c.ts" });
  assert.equal(g2.note("read", { path: "/a/d.ts" }), null); // scoped — never warns
});

t("SCOPE5: mixed chain — scoped actions don't advance the discovery chain", () => {
  const g = createGuard();
  g.note("bash", { command: "ls" }); // pathless 1
  g.note("read", { path: "/a/b.ts" }); // scoped — no advance
  g.note("bash", { command: "find . -type d" }); // scoped (has .) — no advance
  assert.equal(g.note("bash", { command: "rg --no-ignore foo" }), null); // only 2 pathless so far — no warn yet
});

t("SCOPE6: pause still silences even scoped-aware guard", () => {
  const g = createGuard();
  g.suspend(2);
  g.note("bash", { command: "rg --no-ignore foo" });
  assert.equal(g.note("bash", { command: "find / -name x" }), null);
  assert.equal(g.note("read", {}), null);
});

t("SCOPE7: block still fires on repeated unscoped discovery after escalation", () => {
  const g = createGuard();
  for (let i = 0; i < 5; i++) g.note("bash", { command: "rg --no-ignore foo" }); // pathless → warn, escalate
  const b = g.note("bash", { command: "rg --no-ignore foo" });
  assert.ok(b && b.block === true);
});

t("SCOPE8: read tool chain warns/escalates/blocks identically to bash (tool path pinned)", () => {
  const g = createGuard();
  g.note("read", {});
  g.note("read", {});
  const w = g.note("read", {}); // 3rd pathless read — warn
  assert.ok(w && w.includes("⚠️"));
  const esc = g.note("read", {}); // 4th — escalate
  assert.ok(esc && esc.includes("🛑"));
  const b = g.note("read", {}); // 5th — block
  assert.ok(b && b.block === true);
});

t("SCOPE9: scoped searches never fire even at block stage (pathless discovery still blocks)", () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) g.note("bash", { command: "rg --no-ignore foo" }); // chain 3, firing 1 warn
  g.note("bash", { command: "rg --no-ignore bar" }); // firing 2 escalate
  assert.equal(g.note("read", { path: "/a/b.ts" }), null); // scoped read at escalated stage — benign
  assert.equal(g.note("bash", { command: "find /Users/arihantdeva/Repos/heimdall -name x" }), null); // scoped bash at escalated stage — benign
  const b = g.note("bash", { command: "rg --no-ignore foo" }); // pathless again → block
  assert.ok(b && b.block === true);
});

t("SCOPE10: realistic agent patterns — scoped repo search chains never warn", () => {
  const g = createGuard();
  assert.equal(g.note("bash", { command: "rg --no-ignore -n foo src/" }), null);
  assert.equal(g.note("bash", { command: "find /Users/arihantdeva/Repos/heimdall -name '*.ts'" }), null);
  assert.equal(g.note("bash", { command: "ls ~/Repos" }), null);
  assert.equal(g.note("bash", { command: "cd ~/x && rg --no-ignore foo" }), null);
  assert.equal(g.note("bash", { command: "cat f | grep x" }), null); // has path token f
  assert.equal(g.note("read", { path: "/a/b.ts" }), null);
});
