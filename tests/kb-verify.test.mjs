// extract_paths home-anchor contract (bin/kb_search_verify.py): only ~/... and
// /Users/<name>/... count. Regression tests for the tilde-form bug (the old
// HOME_RE pattern `~?/Users/...` could never match `~/...` prose at all, which
// silently hid every ~-anchored node from both search verdicts and the stale scan).
// The module's retired graft-retrieve verdict CLI is gone; its tests went with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function extractPaths(text) {
  const r = spawnSync("python3", ["-c", `
import sys; sys.path.insert(0, "bin")
from kb_search_verify import extract_paths
print("\\n".join(extract_paths(sys.argv[1])))
`, text], { cwd: ROOT, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean);
}

const HOME = homedir();

test("extract_paths: ~-anchored path resolves (tilde form bug regression)", () => {
  const paths = extractPaths("note: ~/Repos/poker-bot/tools — heads-up jam/fold EV optimizer");
  assert.deepEqual(paths, [join(HOME, "Repos/poker-bot/tools")]);
});

test("extract_paths: home-anchored absolute form still resolves", () => {
  // macOS layout: /Users/<name>/...; Linux: /home/<user>/... is HOME-anchored.
  const macAbs = "/Users/arihantdeva/Repos/heimdall/README.md";
  if (process.platform === "darwin") {
    assert.deepEqual(extractPaths(`see ${macAbs} — markdown`), [macAbs]);
  } else {
    // On Linux, /Users/* is NOT a known anchor — nothing resolves.
    assert.deepEqual(extractPaths(`see ${macAbs} — markdown`), []);
    const linAbs = join(HOME, "Repos/heimdall/README.md");
    assert.deepEqual(extractPaths(`see ${linAbs} — markdown`), [linAbs]);
  }
});

test("extract_paths: no path token yields nothing", () => {
  assert.deepEqual(extractPaths("no path here at all"), []);
});
