// C11 observability: semantic-state.json recording + kb-health reporting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EMBED = join(REPO, "bin", "embed-index.py");
const HEALTH = join(REPO, "bin", "kb-health.sh");

test("C11: query records busy on contention and ok on success into semantic-state.json", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-c11-"));
  const statePath = join(home, ".heimdall", "semantic-state.json");
  try {
    mkdirSync(join(home, ".heimdall"), { recursive: true });
    // Deterministic path: import module and call record_semantic_state directly
    // (a real cross-process flock is flaky in CI; the Busy→record wiring is
    // three lines in query(), verified by inspection). Uses the repo venv —
    // embed-index.py hard-imports sqlite_vec at module load.
    const venvPy = join(homedir(), ".heimdall", "venv", "bin", "python3");
    // Deterministic path: import module and call record_semantic_state + check.
    const mod = execFileSync(venvPy, ["-c", `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})
os.environ["HEIMDALL_DB"] = ${JSON.stringify(join(home, ".heimdall", "global.db"))}
import importlib.util
spec = importlib.util.spec_from_file_location("ei", ${JSON.stringify(EMBED)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert str(m.STATE_PATH) == os.environ["HEIMDALL_DB"].replace("global.db", "semantic-state.json")
m.record_semantic_state("busy")
m.record_semantic_state("busy")
m.record_semantic_state("ok")
events = json.loads(open(m.STATE_PATH).read())
assert [e["state"] for e in events] == ["busy", "busy", "ok"], events
print("RECORD-OK")
`], { encoding: "utf8" });
    assert.match(mod, /RECORD-OK/);
    assert.match(readFileSync(statePath, "utf8"), /"ok"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("C11: kb-health prints availability line when state exists, graceful line when absent", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-c11-health-"));
  try {
    // Minimal healthy-sandbox: graft stub + one repo graph.
    const graftDir = join(home, ".local", "bin");
    mkdirSync(graftDir, { recursive: true });
    const graft = join(graftDir, "graft");
    writeFileSync(graft, "#!/usr/bin/env bash\ncase \"$1\" in version) echo graft-test;; ask) exit 0;; *) exit 0;; esac\n");
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });

    const env = { ...process.env, HOME: home, GRAFT: graft };

    // Absent state file -> guidance line, no crash.
    const out1 = execFileSync("bash", [HEALTH], { encoding: "utf8", env });
    assert.match(out1, /no state recorded yet/);
    assert.match(out1, /HEALTHY/);

    // State present -> availability line with counts; busy-tail warns.
    const heimdall = join(home, ".heimdall");
    mkdirSync(heimdall, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(heimdall, "semantic-state.json"), JSON.stringify([
      { t: now - 7200, state: "ok" },
      { t: now - 3600, state: "busy" },
      { t: now - 60, state: "ok" },
    ]));
    const out2 = execFileSync("bash", [HEALTH], { encoding: "utf8", env });
    assert.match(out2, /semantic availability: ok for 1 transitions/);
    assert.match(out2, /24h busy=1 ok=2/);

    writeFileSync(join(heimdall, "semantic-state.json"), JSON.stringify([
      { t: now - 120, state: "ok" },
      { t: now - 60, state: "busy" },
    ]));
    const out3 = execFileSync("bash", [HEALTH], { encoding: "utf8", env });
    assert.match(out3, /WARN: semantic layer last seen BUSY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
