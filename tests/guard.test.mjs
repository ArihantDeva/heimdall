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
