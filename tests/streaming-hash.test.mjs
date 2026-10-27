import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desiredState, sha256 } from "../bin/lib/extract.mjs";
import { Journal } from "../bin/lib/journal.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { audit, drain } from "../bin/lib/reconcile.mjs";

const CAP = { max: "file", python: null, reason: "test" };
function fixture(t, body) {
  const dir = fs.mkdtempSync(join(tmpdir(), "heimdall-hash-"));
  const path = join(dir, "data.bin");
  fs.writeFileSync(path, body);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, path };
}
function patchFs(t, methods) {
  for (const [name, fn] of Object.entries(methods)) t.mock.method(fs, name, fn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("bounded hashing preserves empty, binary and partial-final-chunk digests", (t) => {
  const { path } = fixture(t, "");
  for (const body of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1]), Buffer.alloc(2 * 256 * 1024 + 17, 97)]) {
    fs.writeFileSync(path, body);
    for (const depth of ["path", "file"]) {
      const state = desiredState(path, depth, { cap: CAP });
      assert.equal(state.hash, sha256(body));
      assert.equal(state.size, body.length);
      assert.equal(state.depth, depth);
    }
  }
});

test("hashing reuses one bounded buffer and reads through EOF, not the earlier stat size", (t) => {
  const body = Buffer.alloc(2 * 256 * 1024 + 17, 98);
  const { path } = fixture(t, body);
  const read = fs.readSync;
  const stat = fs.statSync;
  const buffers = new Set();
  let reads = 0;
  patchFs(t, {
    statSync(p, ...args) {
      const st = stat(p, ...args);
      if (p === path) st.size = 0; // file grew after stat; do not truncate the hash
      return st;
    },
    readSync(fd, buf, offset, length, position) {
      buffers.add(buf);
      assert.ok(length >= 64 * 1024 && length <= 256 * 1024);
      reads++;
      return read(fd, buf, offset, length, position);
    },
  });
  assert.equal(desiredState(path, "path").hash, sha256(body));
  assert.ok(reads > 1);
  assert.equal(buffers.size, 1);
});

test("a simulated over-2-GiB stat does not invoke the whole-file Buffer API", (t) => {
  const body = Buffer.from("bounded hashing does not depend on a file-sized allocation");
  const { path } = fixture(t, body);
  const stat = fs.statSync;
  const readFile = fs.readFileSync;
  patchFs(t, {
    statSync(p, ...args) {
      const st = stat(p, ...args);
      if (p === path) st.size = 3_919_507_637;
      return st;
    },
    readFileSync(p, ...args) {
      if (p === path) throw Object.assign(new Error("file too large"), { code: "ERR_FS_FILE_TOO_LARGE" });
      return readFile(p, ...args);
    },
  });
  const state = desiredState(path, "file", { cap: CAP });
  assert.equal(state.hash, sha256(body));
  assert.equal(state.size, 3_919_507_637);
  assert.equal(state.nodes.length, 1, "no new admission or truncation policy");
});

test("a mid-read error propagates and closes the hash descriptor", (t) => {
  const { path } = fixture(t, "content");
  const open = fs.openSync;
  const fstat = fs.fstatSync;
  let targetFd;
  patchFs(t, {
    openSync(p, ...args) {
      const fd = open(p, ...args);
      if (p === path) targetFd = fd;
      return fd;
    },
    readSync() { throw Object.assign(new Error("read failed"), { code: "EIO" }); },
  });
  assert.throws(() => desiredState(path, "file"), /read failed/);
  assert.throws(() => fstat(targetFd), { code: "EBADF" });
});

test("reconcile and deep audit converge without whole-file reads for ordinary files", (t) => {
  const { dir, path } = fixture(t, "old");
  const journal = new Journal(join(dir, "journal.db"));
  t.after(() => journal.close());
  const ctx = { journal, sink: new MemorySink(), cap: CAP, config: { depth: "file" } };
  const readFile = fs.readFileSync;
  patchFs(t, { readFileSync(p, ...args) {
    if (p === path) throw Object.assign(new Error("whole-file read forbidden"), { code: "ERR_FS_FILE_TOO_LARGE" });
    return readFile(p, ...args);
  } });
  for (const body of ["old", "new bytes"]) {
    fs.writeFileSync(path, body);
    journal.enqueue(path);
    const { results } = drain(ctx);
    assert.ok(["indexed", "updated"].includes(results[0].action));
    assert.equal(journal.getPath(path).hash, sha256(body));
    assert.equal(journal.queueDepth(), 0);
    assert.deepEqual(audit(ctx, { deep: true, enqueue: false }), []);
  }
});

test("opted-in fact extraction still hashes and parses the same full buffer", (t) => {
  const body = Buffer.from('{"text":"I prefer SQLite for storage."}\n');
  const { path } = fixture(t, body);
  const state = desiredState(path, "file", { facts: true, cap: CAP });
  assert.equal(state.hash, sha256(body));
  assert.equal(state.nodes.filter((n) => n.kind === "fact").length, 1);
  assert.equal(state.nodes.find((n) => n.kind === "fact").title, "I prefer SQLite for storage");
});
