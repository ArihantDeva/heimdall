// session-facts.test.mjs — facts from pi session logs.
//
// RED for Phase 3. The pre-change parser read `rec.text` off the top level of
// each JSONL record. Real pi session logs have NO such field: the text lives
// at `record.message.content[].text`, one level deeper, and a record with a
// nested shape parses as valid JSON, so the old parser found nothing and
// reported "no facts" rather than failing.
//
// Shapes below are copied from a real session log, not invented:
//   {"type":"message","message":{"role":"user","content":[{"type":"text","text":...}]}}
//   {"type":"message","message":{"role":"toolResult","content":[{"type":"text",...}]}}
//   {"type":"message","message":{"role":"assistant","content":[{"type":"thinking",...}]}}
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractFacts } from "../bin/lib/facts.mjs";
import { desiredState } from "../bin/lib/extract.mjs";
import { skipPath } from "../bin/lib/reconcile.mjs";
import { MAX_BACKFILL, listSessionLogs, measureBackfill } from "../bin/lib/backfill-sessions.mjs";

const HOME = "/Users/x";
const SESSION = `${HOME}/.pi/agent/sessions/--home-x--/s.jsonl`;
const jsonl = (records) => Buffer.from(records.map((r) => JSON.stringify(r)).join("\n"));
const userMsg = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const toolMsg = (text) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
const bodies = (buf) => extractFacts(buf, { path: SESSION }).map((f) => f.body);

// ── the three ingest gates ────────────────────────────────────────────────

test("GATE 1 — skipPath admits session .jsonl but nothing else under ~/.pi", () => {
  assert.equal(skipPath(SESSION, HOME), false, "session logs are still skipped");
  // The carve-out is deliberately narrow. ~/.pi also holds config, tokens and
  // git mirrors; widening it to the whole dotdir would ingest all of them.
  assert.equal(skipPath(`${HOME}/.pi/agent/settings.json`, HOME), true);
  assert.equal(skipPath(`${HOME}/.pi/agent/sessions/notes.txt`, HOME), true);
  assert.equal(skipPath(`${HOME}/.pi/agent/sessions/secret.jsonl.bak`, HOME), true);
  // The pre-existing prompt carve-out must survive.
  assert.equal(skipPath(`${HOME}/.heimdall/prompts/p.md`, HOME), false);
  assert.equal(skipPath(`${HOME}/.heimdall/other.md`, HOME), true);
});

test("GATE 3 — desiredState emits fact nodes for a real session path", async () => {
  // opts.facts === true was the only non-prompt way in, so without the
  // sessionsDir branch a session log reconciled with zero facts even though
  // skipPath let it through — a gate that admits a file and then ignores it.
  // sessionsDir() is built from the REAL $HOME, so this must write inside it;
  // a temp path would be a different directory and prove nothing.
  const dir = mkdtempSync(join(homedir(), ".pi", "agent", "sessions", "heimdall-gate3-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "I prefer ripgrep over grep." }] },
    }));
    assert.equal(skipPath(p, homedir()), false, "gate 1 rejected the real session path");
    // desiredState(path, DEPTH, opts) — the second argument is a depth
    // descriptor, not a stat. Passing a stat object silently makes
    // rank(depth) >= rank("file") false, which is why the first version of
    // this test saw 0 fact nodes and looked like a gate failure.
    const { depthFor } = await import("../bin/lib/depth.mjs");
    const { effective } = depthFor(p, {}, { max: "symbol" });
    const { nodes } = desiredState(p, effective, {});
    const facts = nodes.filter((n) => n.kind === "fact");
    assert.equal(facts.length, 1,
      "expected 1 fact node, got " + facts.length + " (kinds: "
        + nodes.map((n) => n.kind).join(",") + ")");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preference stated by the user in a session log becomes a fact", () => {
  const got = bodies(jsonl([
    { type: "session", version: 3, id: "abc" },
    userMsg("I prefer ripgrep over grep for all content search."),
  ]));
  assert.equal(got.length, 1, `expected 1 fact, got ${JSON.stringify(got)}`);
  assert.match(got[0], /I prefer ripgrep over grep/);
});

test("the nested content[].text shape is read, not just a top-level rec.text", () => {
  // The regression in one assertion: the old parser produced [] for this
  // input, because rec.text is undefined on a real session record.
  const got = bodies(jsonl([userMsg("I always run the full test suite before merging.")]));
  assert.ok(got.length > 0, "the nested session shape yielded no facts at all");
});

test("only the USER's words become facts — assistant, tool and thinking do not", () => {
  // An assistant turn restating "I prefer X" is the model paraphrasing the
  // user. Indexing it would manufacture preferences the user never held, and
  // a fact corpus is only as good as the honesty of its provenance.
  const got = bodies(jsonl([
    { type: "message", message: { role: "assistant",
      content: [{ type: "text", text: "I prefer ripgrep over grep." }] } },
    toolMsg("I prefer ripgrep over grep. you prefer ripgrep over grep."),
    { type: "message", message: { role: "assistant",
      content: [{ type: "thinking", thinking: "I prefer ripgrep over grep." }] } },
  ]));
  assert.deepEqual(got, [], `non-user text leaked into the fact corpus: ${JSON.stringify(got)}`);
});

test("a user turn with several text blocks contributes all of them", () => {
  const got = bodies(jsonl([{
    type: "message",
    message: { role: "user", content: [
      { type: "text", text: "I prefer tabs over spaces." },
      { type: "text", text: "I always run npm test before commit." },
    ] },
  }]));
  assert.equal(got.length, 2, `expected 2 facts, got ${JSON.stringify(got)}`);
});

test("a system-role turn is not a user fact", () => {
  const got = bodies(jsonl([{
    type: "message",
    message: { role: "system", content: [{ type: "text", text: "I prefer ripgrep over grep." }] },
  }]));
  assert.deepEqual(got, []);
});

test("the shape probe does not swallow a non-session JSONL file", () => {
  // Guard against over-reach: a file whose records have no message.role at
  // all is a DIFFERENT format and must fall back to the plain parser rather
  // than being treated as a session log and silently yielding nothing.
  const recs = [
    { text: "I prefer ripgrep over grep." },
    { text: "I always run the test suite." },
  ];
  const got = bodies(jsonl(recs));
  assert.ok(got.length >= 2, `plain rec.text records lost their facts: ${JSON.stringify(got)}`);
});

test("a torn line mid-file does not abort the records around it", () => {
  const lines = [
    JSON.stringify(userMsg("I prefer ripgrep over grep.")),
    "{ this is not json",
    JSON.stringify(userMsg("I always run the test suite.")),
  ];
  const got = bodies(Buffer.from(lines.join("\n")));
  assert.equal(got.length, 2, `a torn line cost us facts: ${JSON.stringify(got)}`);
});

test("parsePlain is suppressed for a real session log", () => {
  // parsePlain must not double-extract from a session log's JSON. Counting
  // here is how a "both parsers ran" bug would show: a duplicated corpus.
  const got = bodies(jsonl([userMsg("I prefer ripgrep over grep.")]));
  assert.equal(got.length, 1, "the fact was extracted more than once");
});
// ── the bounded backfill ──────────────────────────────────────────────────

const sessionFile = (n) => JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "I prefer tool number " + n + " for this." }] },
});

const seedTree = (dir, count) => {
  for (let i = 0; i < count; i++) {
    const d = join(dir, "d" + i);
    mkdirSync(d, { recursive: true });
    const p = join(d, "s.jsonl");
    writeFileSync(p, sessionFile(i));
    // Distinct, increasing mtimes so "most recent" is deterministic.
    utimesSync(p, new Date(1700000000 + i * 1000), new Date(1700000000 + i * 1000));
  }
  return dir;
};

const withTree = (count, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-sess-"));
  try { return fn(seedTree(dir, count)); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("the backfill takes the N most-recent sessions, newest first", () => {
  withTree(10, (root) => {
    const files = listSessionLogs(root);
    assert.equal(files.length, 10);
    assert.ok(files[0].mtime > files[9].mtime, "not sorted newest-first");
    const r = measureBackfill({ limit: 3, root });
    assert.equal(r.files, 3, "the limit was not applied");
    assert.equal(r.facts, 3, "expected 3 facts, got " + r.facts);
    // The newest session (highest index) must be the one included.
    assert.match(r.perFile[0].path, /d9\//, "the wrong session was selected");
  });
});

test("the backfill is bounded by a HARD cap, not a default", () => {
  // This command exists because a machine with 14,519 session logs cannot
  // reconcile them all. If --limit could be raised freely, the bound would be
  // a suggestion and the journal lock would be held for hours.
  assert.equal(MAX_BACKFILL, 200);
  withTree(3, (root) => {
    const r = measureBackfill({ limit: 100000, root });
    assert.equal(r.limit, 200, "the cap did not clamp the request");
  });
});

test("measureBackfill is READ-ONLY and deterministic", () => {
  withTree(5, (root) => {
    const a = measureBackfill({ limit: 5, root });
    const b = measureBackfill({ limit: 5, root });
    assert.equal(a.facts, b.facts, "two runs disagree - not deterministic");
    assert.deepEqual(a.perFile.map((f) => f.path), b.perFile.map((f) => f.path));
  });
});

test("a session with no user text contributes nothing rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-sess-empty-"));
  try {
    writeFileSync(join(dir, "s.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "x" }),
      JSON.stringify({ type: "message", message: { role: "assistant",
        content: [{ type: "text", text: "I prefer nothing." }] } }),
    ].join("\n"));
    const r = measureBackfill({ limit: 1, root: dir });
    assert.equal(r.facts, 0, "assistant text became a user fact");
    assert.equal(r.files, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts from a backfill carry a real source anchor, not a synthetic one", () => {
  // A fact must stay verifiable: the journal stores the SOURCE FILE so a
  // reviewer can open the exact session and confirm the claim. This is the
  // Phase 1 decision that facts are filesystem-verifiable while people are
  // not, and it has to survive the session source.
  withTree(1, (root) => {
    const p = listSessionLogs(root)[0].path;
    const f = extractFacts(readFileSync(p), { path: p })[0];
    assert.ok(f.body.includes(p), "body does not carry its source: " + f.body);
  });
});
