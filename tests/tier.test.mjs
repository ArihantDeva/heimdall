// tier.test.mjs — two-tier variant split contract (goal criterion #2).
// CPU-only base: zero LLM calls at runtime. Agent-memory tier: LLM
// extraction behind explicit config (memory.tier="agent"). Targets public
// exports only; the LLM is always injected — no network in any test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTier } from "../bin/lib/tier.mjs";
import { agentExtract } from "../bin/lib/agent-memory.mjs";
import { extractFacts } from "../bin/lib/facts.mjs";

// ── tier resolution ──────────────────────────────────────────────────────
test("TR-01 default/empty config resolves to cpu (zero-LLM promise)", () => {
  assert.deepEqual(resolveTier({}), { tier: "cpu", requested: undefined });
  assert.deepEqual(resolveTier(), { tier: "cpu", requested: undefined });
});
test("TR-02 explicit memory.tier=agent selects the agent tier", () => {
  assert.deepEqual(resolveTier({ memory: { tier: "agent" } }),
    { tier: "agent", requested: "agent" });
});
test("TR-03 explicit memory.tier=cpu stays cpu", () => {
  assert.deepEqual(resolveTier({ memory: { tier: "cpu" } }),
    { tier: "cpu", requested: "cpu" });
});
test("TR-04 unknown tier values fall back to cpu, never throw", () => {
  for (const bad of ["bogus", "", null, 42, {}, true]) {
    const r = resolveTier({ memory: { tier: bad } });
    assert.equal(r.tier, "cpu");
  }
});
test("TR-05 tier match is case-insensitive", () => {
  assert.equal(resolveTier({ memory: { tier: "AGENT" } }).tier, "agent");
});

// ── agent-memory extraction (fake LLM, fully offline) ────────────────────
const PATH = "/tmp/proj/notes.md";
const fakeLlm = (reply) => async (prompt) => {
  assert.ok(prompt.includes("Extract"), "prompt must carry extraction intent");
  return reply;
};

test("AM-01 agent facts carry the same contract keys as CPU facts", async () => {
  const reply = JSON.stringify([
    { title: "Prefers SQLite over Postgres", body: "I prefer SQLite.", kind: "preference" },
  ]);
  const facts = await agentExtract(Buffer.from("I prefer SQLite.\n"),
    { path: PATH }, { llm: fakeLlm(reply) });
  assert.equal(facts.length, 1);
  assert.deepEqual(Object.keys(facts[0]).sort(),
    ["body", "id", "keywords", "line", "title"]);
});
test("AM-02 deterministic per bytes+LLM reply (ids included)", async () => {
  const reply = JSON.stringify([
    { title: "Uses ripgrep", body: "I use ripgrep.", kind: "assertion" },
  ]);
  const args = [Buffer.from("I use ripgrep.\n"), { path: PATH }];
  const a = await agentExtract(...args, { llm: fakeLlm(reply) });
  const b = await agentExtract(...args, { llm: fakeLlm(reply) });
  assert.deepEqual(a, b);
});
test("AM-03 malformed LLM output yields [] — never throws", async () => {
  for (const junk of ["not json", '{"oops":1}', "[]", "```json\n{}\n```"]) {
    const facts = await agentExtract(Buffer.from("I prefer tabs.\n"),
      { path: PATH }, { llm: fakeLlm(junk) });
    assert.ok(Array.isArray(facts));
  }
});
test("AM-04 missing llm caller is a config error naming the tier", async () => {
  await assert.rejects(
    () => agentExtract(Buffer.from("x"), { path: PATH }, {}),
    /agent.*llm|llm.*agent/i);
});
test("AM-05 secret-shaped LLM content is dropped (trust boundary holds)", async () => {
  const reply = JSON.stringify([
    { title: "ok fact", body: "I use bun.", kind: "assertion" },
    { title: "leak", body: "my key is sk-abcdefghijklmnopqrstuvwx", kind: "assertion" },
  ]);
  const facts = await agentExtract(Buffer.from("mixed\n"),
    { path: PATH }, { llm: fakeLlm(reply) });
  assert.equal(facts.length, 1);
  assert.ok(!JSON.stringify(facts).includes("sk-"));
});
test("AM-06 titles are truncated to 120 chars like CPU facts", async () => {
  const long = "word ".repeat(60);
  const reply = JSON.stringify([{ title: long, body: long, kind: "assertion" }]);
  const [f] = await agentExtract(Buffer.from(long),
    { path: PATH }, { llm: fakeLlm(reply) });
  assert.ok(f.title.length <= 120);
});

// ── tier selection parity: both tiers share one node contract ────────────
test("TP-01 cpu and agent tiers produce mergeable shapes for the same input",
  async () => {
    const buf = Buffer.from("I prefer SQLite over Postgres.\n");
    const meta = { path: PATH };
    const cpu = extractFacts(buf, { ...meta });
    const reply = JSON.stringify(
      [{ title: "I prefer SQLite over Postgres.",
         body: "I prefer SQLite over Postgres.", kind: "preference" }]);
    const agent = await agentExtract(buf, { ...meta }, { llm: fakeLlm(reply) });
    for (const f of [...cpu, ...agent]) {
      assert.deepEqual(Object.keys(f).sort(),
        ["body", "id", "keywords", "line", "title"]);
    }
  });
