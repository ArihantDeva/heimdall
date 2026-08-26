import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Lock } from "../bin/lib/lock.mjs";
import {
  MEMORY_SCHEMA,
  insertMemory,
  memoryDir,
  memoryLockPath,
  readMemory,
  searchMemories,
} from "../bin/lib/manual-memory.mjs";

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-memory-"));
  return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("manual memory: atomic insert preserves the exact record and permissions", async () => {
  const s = sandbox();
  try {
    const body = "First line.\nUnicode survives: café λ.\n";
    const result = await insertMemory({
      title: "Durable title",
      body,
      keywords: ["ORM", "modeling"],
      cwd: "/work/one",
      home: s.home,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });

    assert.deepEqual(result, {
      id: "mem-00000000-0000-4000-8000-000000000001",
      path: join(memoryDir(s.home), "mem-00000000-0000-4000-8000-000000000001.json"),
      title: "Durable title",
      searchable: true,
    });
    assert.deepEqual(readMemory(result.path), {
      schema: MEMORY_SCHEMA,
      id: result.id,
      title: "Durable title",
      body,
      keywords: ["ORM", "modeling"],
      createdAt: "2026-08-25T12:00:00.000Z",
      cwd: "/work/one",
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(memoryDir(s.home)).mode & 0o777, 0o700);
      assert.equal(statSync(result.path).mode & 0o777, 0o600);
    }
    assert.deepEqual(readdirSync(memoryDir(s.home)).filter((n) => n.includes(".tmp")), []);
  } finally {
    s.clean();
  }
});

test("manual memory: explicit secrets fail closed without writing content", async () => {
  const s = sandbox();
  try {
    await assert.rejects(
      insertMemory({
        title: "Credential",
        body: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.s3cr3tsignature",
        home: s.home,
      }),
      /secret-shaped content/i,
    );
    const written = existsSync(memoryDir(s.home))
      ? readdirSync(memoryDir(s.home)).filter((n) => n.endsWith(".json")).length : 0;
    assert.equal(written, 0);
  } finally {
    s.clean();
  }
});

test("manual memory: a live store lock returns a useful busy error", async () => {
  const s = sandbox();
  const lock = new Lock(memoryLockPath(s.home));
  try {
    assert.equal(lock.acquire(), true);
    await assert.rejects(
      insertMemory({ title: "Busy", body: "Must not be lost", home: s.home }),
      /memory store is busy/i,
    );
  } finally {
    lock.release();
    s.clean();
  }
});

test("manual memory: concurrent inserts produce complete unique records", async () => {
  const s = sandbox();
  try {
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      insertMemory({
        title: `Concurrent ${i}`,
        body: `Durable body ${i}`,
        home: s.home,
      }),
    ));
    assert.equal(new Set(records.map((r) => r.id)).size, 8);
    assert.equal(records.filter((r) => readMemory(r.path)?.schema === MEMORY_SCHEMA).length, 8);
    assert.deepEqual(readdirSync(memoryDir(s.home)).filter((n) => n.includes(".tmp")), []);
  } finally {
    s.clean();
  }
});

test("manual memory: an id collision cannot replace an existing record", async () => {
  const s = sandbox();
  const idFactory = () => "00000000-0000-4000-8000-000000000002";
  try {
    const original = await insertMemory({
      title: "Original", body: "Keep this exact body.", home: s.home, idFactory,
    });
    await assert.rejects(
      insertMemory({ title: "Replacement", body: "Must not overwrite.", home: s.home, idFactory }),
      /already exists/i,
    );
    assert.equal(readMemory(original.path).body, "Keep this exact body.");
    assert.deepEqual(readdirSync(memoryDir(s.home)).filter((n) => n.includes(".tmp")), []);
  } finally {
    s.clean();
  }
});

test("manual memory: search ranks title, keywords, body, then cwd", async () => {
  const s = sandbox();
  try {
    const fixtures = [
      ["quasar title", "plain", [], "/work/a"],
      ["keyword hit", "plain", ["quasar"], "/work/b"],
      ["body hit", "quasar body", [], "/work/c"],
      ["cwd hit", "plain", [], "/work/quasar"],
    ];
    for (const [title, body, keywords, cwd] of fixtures) {
      await insertMemory({ title, body, keywords, cwd, home: s.home });
    }
    const hits = searchMemories("quasar", { home: s.home, limit: 10 });
    assert.deepEqual(hits.map((h) => h.title),
      ["quasar title", "keyword hit", "body hit", "cwd hit"]);
    assert.ok(hits.every((h) => statSync(h.path).isFile()));
  } finally {
    s.clean();
  }
});

test("manual memory: malformed and foreign JSON records are ignored", async () => {
  const s = sandbox();
  try {
    mkdirSync(memoryDir(s.home), { recursive: true });
    chmodSync(memoryDir(s.home), 0o700);
    writeFileSync(join(memoryDir(s.home), "broken.json"), "{not-json");
    writeFileSync(join(memoryDir(s.home), "foreign.json"), JSON.stringify({ schema: "other.v1" }));
    assert.deepEqual(searchMemories("anything", { home: s.home }), []);
    assert.equal(readFileSync(join(memoryDir(s.home), "broken.json"), "utf8"), "{not-json");
  } finally {
    s.clean();
  }
});

test("manual memory: semantic card projection uses validated canonical records", async () => {
  const s = sandbox();
  try {
    const stored = await insertMemory({
      title: "Semantic zircon memory",
      body: "Acyclic precedence is required.",
      keywords: ["zircon", "acyclic"],
      cwd: "/work/modeling",
      home: s.home,
    });
    writeFileSync(join(memoryDir(s.home), "broken.json"), "{not-json");
    const result = spawnSync("python3", [join(ROOT, "bin", "manual_memory_cards.py")], {
      encoding: "utf8", env: { ...process.env, HOME: s.home },
    });
    assert.equal(result.status, 0, result.stderr);
    const cards = JSON.parse(result.stdout);
    assert.equal(cards.length, 1);
    assert.equal(cards[0][0], `memory:${stored.id}`);
    assert.equal(cards[0][3], "Semantic zircon memory");
    assert.match(cards[0][4], /Acyclic precedence is required/);
    assert.match(cards[0][4], /keywords: zircon acyclic/);
  } finally {
    s.clean();
  }
});
