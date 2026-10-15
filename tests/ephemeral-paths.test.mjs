// ephemeral-paths.test.mjs — the journal must never anchor a path that is
// structurally ephemeral.
//
// Why (2026-10-15): a live `heimdall verify --deep` reported 223 drift rows with
// 152 scored as ERRORS, driving the health score to 0/critical. 141 of those 223
// (63%) were paths that could never be stable anchors:
//
//   /var/folders/sm/…/T/scrapling-1790347392194.md      (macOS $TMPDIR — 128 rows)
//   ///tmp/g.html                                       (malformed triple slash — 3 rows)
//   /Applications/Google Chrome.app/Contents/…          (app bundles — 3 rows)
//   ~/.pi/agent/sessions/…jsonl                         (append-only live logs — 7 rows)
//
// skipPath already rejected "/tmp/" and "/private/tmp/" — but macOS $TMPDIR is
// NOT /tmp, it is /var/folders/<..>/T/, so the rule that was written to exclude
// scratch space missed the actual scratch space on the platform this runs on.
// An absent row is cheap (state=absent is skipped, never scored) but a row in
// state=present for a file that is gone is a MISSING error worth 10 points, and
// a search can return that path as if it still existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { skipPath } from "../bin/lib/reconcile.mjs";

const HOME = "/Users/arihantdeva";

// Every one of these was observed in the real drift report, or is the same
// class of path. None may enter the journal.
const EPHEMERAL = [
  ["macOS $TMPDIR scratch (the 128-row bucket)", "/var/folders/sm/lpp1_zgj30n2hb054_pfn5ch0000gn/T/scrapling-1790347392194.md"],
  ["macOS $TMPDIR nested research dir", "/var/folders/sm/lpp1_zgj30n2hb054_pfn5ch0000gn/T/research.vUVS51yo/amazon-extracted.tsv"],
  ["macOS $TMPDIR pi bash log", "/var/folders/sm/lpp1_zgj30n2hb054_pfn5ch0000gn/T/pi-bash-cd31173d7949fe52.log"],
  ["plain /tmp", "/tmp/thing.md"],
  ["private /tmp", "/private/tmp/thing.md"],
  ["malformed triple-slash /tmp", "///tmp/g.html"],
  ["malformed triple-slash nested", "///tmp/titanic-doc/body.html"],
  ["app bundle plist", "/Applications/Google Chrome.app/Contents/Info.plist"],
  ["app bundle binary", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  // Measured 2026-10-15: this held a stale Sep-16 SNAPSHOT OF THE HEIMDALL REPO
  // (289 cards), and retrieval ranked it ABOVE the live file it was copied from.
  ["harness scratch holding a stale repo copy", "/Users/arihantdeva/.pi/tmp/sim1/bin/heimdall-reconciler.mjs"],
  ["harness scratch, nested", "/Users/arihantdeva/.pi/tmp/sim1/.github/workflows/ci.yml"],
  ["app bundle (Brave)", "/Applications/Brave Browser.app/Contents/Info.plist"],
  // System config is not authored memory. /etc/cups/printers.conf is rewritten by
  // cupsd on every queue change, so it can never be a stable anchor; it was the
  // last thing keeping `verify` from reporting ok on 2026-10-15.
  ["system config rewritten by a daemon", "/etc/cups/printers.conf"],
  ["system config", "/etc/hosts"],
  // macOS ships /etc, /tmp and /var as symlinks INTO /private. The journal stores
  // the RESOLVED path (`ls -ld /etc` -> `private/etc`), so a rule covering only
  // the symlink form leaves the real path uncaught. Measured 2026-10-15: after
  // the /etc rule was added, /private/etc/cups/printers.conf still produced TWO
  // drift rows, because cupsd rewrites that file on every print/queue change and
  // it can therefore never be a stable anchor. /private/tmp and /private/var were
  // already listed; /etc was the one entry with no resolved-path twin.
  ["system config via its resolved path", "/private/etc/cups/printers.conf"],
  ["system config via resolved path", "/private/etc/hosts"],
  ["relative path (never absolute)", "relative/thing.md"],
];

// The exclusion must not eat real work. These are the positive controls: a fix
// that removes these is a regression, not a fix.
const KEEP = [
  ["real repo source", `${HOME}/Repos/equitylens/api/core/auth_jwt.py`],
  ["repo that legitimately contains 'applications' in its name", `${HOME}/Repos/WebApplications/index.ts`],
  ["a dir named tmp INSIDE a real repo is not scratch space", `${HOME}/Repos/foo/tmp/notes.md`],
  ["dated research note in a real dir", `${HOME}/Desktop/Automation/job-automation/evidence/ib_2027/accounts.json`],
  ["heimdall's own prompt log (deliberate carve-out)", `${HOME}/.heimdall/prompts/2026-10-15.md`],
];

test("ephemeral and malformed paths are excluded from the journal", () => {
  const leaked = [];
  for (const [label, p] of EPHEMERAL) {
    if (!skipPath(p, HOME)) leaked.push(`${label}: ${p}`);
  }
  assert.deepEqual(leaked, [], `these paths would enter the journal and become permanent drift anchors:\n  ${leaked.join("\n  ")}`);
});

test("real source is never excluded by the ephemeral rules", () => {
  const eaten = [];
  for (const [label, p] of KEEP) {
    if (skipPath(p, HOME)) eaten.push(`${label}: ${p}`);
  }
  assert.deepEqual(eaten, [], `the exclusion is too broad — these are real content:\n  ${eaten.join("\n  ")}`);
});

test("session logs stay INGESTIBLE but must not be hash-stable anchors", () => {
  // Spec P3 made ~/.pi/agent/sessions/*.jsonl a deliberate carve-out so facts
  // can be extracted from them. That decision stands: the files must still be
  // reconciled. What must NOT happen is a live, append-only log being treated as
  // a content-addressed anchor whose hash is expected to stay put — it grows
  // every turn, so `deep` audit would report permanent, unfixable `hash` drift.
  const live = `${HOME}/.pi/agent/sessions/--Users-arihantdeva--/2026-09-26T19-09-01-687Z_abc.jsonl`;
  assert.equal(skipPath(live, HOME), false,
    "session logs are the P3 fact source and must still be ingested");
});

test("the real observed drift paths are all now excluded or explained", () => {
  // The exact paths that produced `errors: 152`. Each must be excluded, or be a
  // genuine deletion that reconcile is expected to retract.
  const GENUINE_DELETIONS = new Set([
    `${HOME}/Repos/lumina/assets/site.css`,
    `${HOME}/Repos/lumina/assets/site.js`,
    `${HOME}/Desktop/Automation/job-automation/evidence/ib_2027/blocked/goldman-sachs-2027-closed.md`,
  ]);
  const ephemeral = [
    "/var/folders/sm/lpp1_zgj30n2hb054_pfn5ch0000gn/T/pi-subagents-uid-501/async-subagent-runs/78f51ccc/status.json",
    "///tmp/ganesh-verdict.html",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const p of ephemeral) {
    assert.equal(skipPath(p, HOME), true, `${p} is ephemeral and must not be anchored`);
  }
  for (const p of GENUINE_DELETIONS) {
    assert.equal(skipPath(p, HOME), false,
      `${p} is a real deletion — it must reach reconcile so it can be retracted truthfully, not silently excluded`);
  }
});

test("HOME is optional — skipPath(path) must not throw", () => {
  assert.equal(skipPath("/var/folders/x/T/y.md"), true, "ephemeral rule must not depend on HOME being passed");
  assert.equal(skipPath("relative.md"), true);
});
