// reconciler-supervision.test.mjs — the reconciler must be SUPERVISED, not just
// installable.
//
// Why (2026-10-15): `launchctl list` showed com.graft.daemon loaded and NO
// heimdall agent. graftd is the *embedding* daemon; the reconciler
// (bin/heimdall-reconciler.mjs) is a different process — the single writer that
// drains drift. With nothing supervising it, `heimdall verify --deep` reported
// 223 drift rows and they never converged: the audit kept detecting drift and no
// process ever repaired it. Measured proof the repair itself works:
//     heimdall daemon --dry-run -> reconciled 73: {updated:13, retracted:59}
// So the defect was never the repair, it was that nothing ran it.
//
// These tests assert the CONTRACT (setup produces a valid, correctly-targeted
// supervisor definition) using pure helpers, so they never load or unload a real
// launchd agent on a developer machine.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReconcilerPlist, RECONCILER_LABEL, reconcilerPlistPath } from "../bin/lib/setup.mjs";

const NODE = "/usr/local/bin/node";
const RECONCILER = "/Users/x/Repos/heimdall/bin/heimdall-reconciler.mjs";
const LOG = "/Users/x/.heimdall/reconciler.log";

test("the reconciler plist names a distinct label from the embedding daemon", () => {
  assert.equal(RECONCILER_LABEL, "com.heimdall.reconciler");
  assert.notEqual(RECONCILER_LABEL, "com.graft.daemon",
    "the reconciler must not collide with, or be mistaken for, the graft embedding daemon");
  assert.match(reconcilerPlistPath(), /com\.heimdall\.reconciler\.plist$/);
});

test("the reconciler plist is well-formed and uses absolute paths", () => {
  const plist = renderReconcilerPlist(NODE, RECONCILER, LOG);
  // launchd silently fails to load a plist with a relative program path.
  for (const needle of [NODE, RECONCILER]) {
    assert.ok(plist.includes(needle), `plist must contain the absolute path ${needle}`);
  }
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.heimdall\.reconciler<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/,
    "RunAtLoad keeps convergence alive across reboots");
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/,
    "KeepAlive is what makes this supervision rather than a one-shot install");
  assert.match(plist, /StandardOutPath/, "output must be capturable for diagnosis");
  assert.match(plist, /StandardErrorPath/);
});

test("the reconciler plist runs the reconciler, not the daemon's own supervisor form", () => {
  const plist = renderReconcilerPlist(NODE, RECONCILER, LOG);
  // `heimdall daemon` (no --once) is the long-lived supervisor; that is what
  // belongs under launchd. `--once` would exit immediately and KeepAlive would
  // thrash it in a restart loop.
  assert.doesNotMatch(plist, /--once/, "--once under KeepAlive would restart-loop");
});

test("a template placeholder must never be written as a real plist", () => {
  const plist = renderReconcilerPlist(NODE, RECONCILER, LOG);
  for (const bad of ["YOUR_", "<PATH>", "TODO", "CHANGEME", "__PLACEHOLDER__"]) {
    assert.ok(!plist.includes(bad), `placeholder ${bad} would silently fail to load`);
  }
});

test("XML-special characters in paths are escaped", () => {
  const plist = renderReconcilerPlist(NODE, "/Users/a&b/recon.mjs", "/tmp/a<b>.log");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(plist), "a bare & would make the plist invalid XML");
  assert.match(plist, /&amp;/);
  assert.match(plist, /&lt;/);
});
