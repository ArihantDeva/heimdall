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

t("BLOCK4: firing 3+ blocks rg-headed bash, not other bash", () => {
  const g = blockReady();
  // non-search bash passes even at block stage
  assert.equal(g.note("bash", { command: "npm test" }), null);
  assert.equal(g.note("bash", { command: "git status --short" }), null);
  // rg-headed bash IS blocked
  const v = g.note("bash", { command: "rg pattern src/" });
  assert.ok(v && typeof v === "object");
  assert.equal(v.block, true);
});

t("BLOCK8: search binary anywhere in pipe/chain segment is blockable", () => {
  const g = blockReady();
  assert.equal(g.note("bash", { command: "cat f | grep x" }).block, true);
  assert.equal(g.note("bash", { command: "echo hi && ls -la" }).block, true);
  assert.equal(g.note("bash", { command: "rg foo src | head -3" }).block, true);
  assert.equal(g.note("bash", { command: "npm test 2>&1 | tail -5" }), null); // no search head
});

t("BLOCK5: grep/ls/find-headed bash blocked too", () => {
  const g = blockReady();
  assert.equal(g.note("bash", { command: "/usr/bin/grep -rn x ." }).block, true);
  assert.equal(g.note("bash", { command: "ls -la" }).block, true);
  assert.equal(g.note("bash", { command: "find . -name y" }).block, true);
});

t("BLOCK6: kb_search reset clears block state", () => {
  const g = createGuard();
  for (let i = 0; i < 7; i++) g.note("read", {});
  assert.equal(g.note("kb_search", {}), null);
  assert.equal(g.note("read", {}), null); // fresh chain — no warning, no block
});

t("BLOCK7: graft/heimdall bash prefix still resets", () => {
  const g = createGuard();
  for (let i = 0; i < 7; i++) g.note("read", {});
  assert.equal(g.note("bash", { command: "graft status" }), null);
  assert.equal(g.note("bash", { command: "heimdall doctor" }), null);
});
