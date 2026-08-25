// tests/ingest-email.test.mjs — email ingestion pathway (CPU-only, read-only).
// Contract under test (bin/lib/ingest-email.mjs):
//   parseEmailJson   — tolerate cli-email's progress noise before JSON
//   renderEmailCard  — one graft-style .md card per message, uid-keyed path
//   ingestEmail      — orchestrate list→show→write; idempotent re-runs;
//                      ONLY read-only cli-email subcommands (list/show)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { parseEmailJson, renderEmailCard, ingestEmail } = await import(
  "../bin/lib/ingest-email.mjs"
);

const MSG = {
  uid: "15958",
  subject: "[ArihantDeva/pi-private] Run failed: npm audit - main (060ed50)",
  sender: { name: "Deva", email: "notifications@github.com" },
  to: [{ name: "ArihantDeva/pi-private", email: "pi-private@noreply.github.com" }],
  date: "2026-08-25T01:21:38-07:00",
  body_preview: "npm audit workflow run Repository: ArihantDeva/pi-private",
  flags: [],
  size: 1046,
  has_attachments: false,
  account: "a1",
};

test("parseEmailJson extracts JSON from noisy stdout", () => {
  const noisy = '[1/3] a1... 2 emails (793ms)\n\n[{"uid":"1","subject":"s"}]\n';
  const parsed = parseEmailJson(noisy);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].uid, "1");
});

test("parseEmailJson returns [] for garbage instead of throwing", () => {
  assert.deepEqual(parseEmailJson("total nonsense"), []);
});

test("renderEmailCard: uid-keyed rel path, headers, body present", () => {
  const card = renderEmailCard({ ...MSG, body: "Line one\r\nLine two\r\n" });
  assert.equal(card.relPath, "mail/a1/15958.md");
  assert.match(card.markdown, /^# /); // title line
  assert.match(card.markdown, /From: .*notifications@github\.com/);
  assert.match(card.markdown, /Subject: \[ArihantDeva\/pi-private\] Run failed/);
  assert.match(card.markdown, /Date: 2026-08-25T01:21:38-07:00/);
  assert.match(card.markdown, /Line one\nLine two/);
  // CRLF normalized so cards stay stable across fetches
  assert.doesNotMatch(card.markdown, /\r/);
});

test("renderEmailCard: deterministic output (idempotent re-ingest)", () => {
  const a = renderEmailCard({ ...MSG, body: "same" });
  const b = renderEmailCard({ ...MSG, body: "same" });
  assert.equal(a.markdown, b.markdown);
  assert.equal(a.relPath, b.relPath);
});

test("ingestEmail: writes one card per message using ONLY list/show", async () => {
  const root = mkdtempSync(join(tmpdir(), "heimdall-ingest-"));
  try {
    const calls = [];
    const run = (sub, args) => {
      calls.push(sub);
      if (sub === "list") {
        return JSON.stringify({ results: [MSG], _meta: {} });
      }
      if (sub === "show") {
        return JSON.stringify([{ ...MSG, body: "full body here" }]);
      }
      throw new Error(`forbidden subcommand reached runner: ${sub}`);
    };
    const summary = await ingestEmail({
      accounts: ["a1"], limit: 5, root, run,
    });
    assert.deepEqual([...new Set(calls)].sort(), ["list", "show"]);
    const card = join(root, "graft", "mail", "a1", "15958.md");
    assert.match(readFileSync(card, "utf8"), /full body here/);
    assert.equal(summary.fetched, 1);
    assert.equal(summary.written, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ingestEmail: second identical run is a no-op (idempotent)", async () => {
  const root = mkdtempSync(join(tmpdir(), "heimdall-ingest-idem-"));
  try {
    const run = (sub) =>
      sub === "list"
        ? JSON.stringify({ results: [MSG], _meta: {} })
        : JSON.stringify([{ ...MSG, body: "full body here" }]);
    await ingestEmail({ accounts: ["a1"], limit: 5, root, run });
    const card = join(root, "graft", "mail", "a1", "15958.md");
    const before = statSync(card).mtimeMs;
    const summary = await ingestEmail({ accounts: ["a1"], limit: 5, root, run });
    assert.equal(summary.written, 0); // unchanged → not rewritten
    assert.equal(statSync(card).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ingestEmail: empty mailbox writes nothing, reports zeros", async () => {
  const root = mkdtempSync(join(tmpdir(), "heimdall-ingest-empty-"));
  try {
    const run = () => JSON.stringify({ results: [], _meta: {} });
    const summary = await ingestEmail({ accounts: ["zz"], limit: 5, root, run });
    assert.equal(summary.fetched, 0);
    assert.equal(summary.written, 0);
    assert.throws(() => readdirSync(join(root, "graft")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
