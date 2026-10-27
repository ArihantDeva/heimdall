import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const SERVER = fileURLToPath(new URL("../bin/query-server.py", import.meta.url));
const PY = plainPython();
const canFlock = spawnSync(PY, ["-c", "import fcntl"], { encoding: "utf8" }).status === 0;
const gate = { skip: canFlock ? false : "Python fcntl is unavailable" };

// A separate contender runs the real serve() up to the model-import boundary.
// No encoder, numpy, sqlite-vec or live index is needed to test single-flight.
const contender = `
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location("qs", sys.argv[1])
qs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qs)
class ModelImportReached(Exception): pass
def load(): raise ModelImportReached()
qs.load_embed_index = load
try:
    rc = qs.serve(pathlib.Path(sys.argv[2]), 30)
    print(json.dumps({"rc": rc, "imported": False}))
except ModelImportReached:
    print(json.dumps({"imported": True, "pid": os.getpid()}))
`;

function run(body) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-worker-lock-"));
  try {
    const script = `
import fcntl, json, os, pathlib, subprocess, sys
server, directory = sys.argv[1:]
sock = pathlib.Path(directory) / "worker.sock"
lock = pathlib.Path(str(sock) + ".lock")
def attempt():
    p = subprocess.run([sys.executable, "-c", ${JSON.stringify(contender)}, server, str(sock)],
                       capture_output=True, text=True, timeout=20)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)
def hold(text):
    fh = open(lock, "a+")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    fh.seek(0); fh.truncate(); fh.write(text); fh.flush()
    return fh
${body}
print("OK")
`;
    const r = spawnSync(PY, ["-c", script, SERVER, dir], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.match(r.stdout, /OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, text] of [["live PID", "str(os.getpid())"], ["empty PID", '""'],
  ["malformed PID", '"not-a-pid"'], ["dead PID", '"999999999"']]) {
  test(`a held worker lock refuses before import and preserves its inode/text: ${name}`, gate, () => {
    run(`
with hold(${text}) as holder:
    before = lock.stat().st_ino
    text = lock.read_text()
    got = attempt()
    assert got == {"rc": 4, "imported": False}, got
    assert lock.stat().st_ino == before, "contender unlinked the live lock inode"
    assert lock.read_text() == text, "contender truncated the holder's diagnostic PID"
`);
  });
}

test("a released worker lock can be re-acquired without replacing its inode", gate, () => {
  run(`
holder = hold(str(os.getpid()))
before = lock.stat().st_ino
assert attempt() == {"rc": 4, "imported": False}
holder.close()
got = attempt()
assert got["imported"], got
assert lock.read_text() == str(got["pid"])
assert lock.stat().st_ino == before
`);
});

test("an unheld leftover lock is reusable regardless of its diagnostic PID", gate, () => {
  run(`
for text in ("", "999999999", str(os.getpid())):
    lock.write_text(text)
    before = lock.stat().st_ino
    got = attempt()
    assert got["imported"], got
    assert lock.read_text() == str(got["pid"])
    assert lock.stat().st_ino == before
`);
});
