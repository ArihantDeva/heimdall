// manual-memory — immutable, machine-global records written by kb_insert.
// The files are canonical; lexical and semantic indexes are rebuildable views.
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { containsSecret } from "./facts.mjs";
import { Lock } from "./lock.mjs";

export const MEMORY_SCHEMA = "heimdall.memory.v1";
export const memoryDir = (home = homedir()) => join(home, ".heimdall", "memories");
export const memoryLockPath = (home = homedir()) =>
  join(home, ".heimdall", "manual-memory.lock");

const ID_RE = /^mem-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const tokens = (s) =>
  [...new Set(String(s ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];

function normalizedKeywords(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    for (const item of String(value).split(",")) {
      const keyword = item.trim();
      const key = keyword.toLocaleLowerCase();
      if (keyword && !seen.has(key)) {
        seen.add(key);
        out.push(keyword);
      }
    }
  }
  return out;
}

function validRecord(record, path) {
  return record?.schema === MEMORY_SCHEMA &&
    typeof record.id === "string" && ID_RE.test(record.id) &&
    (!path || basename(path) === `${record.id}.json`) &&
    typeof record.title === "string" && record.title.trim().length > 0 &&
    typeof record.body === "string" && record.body.trim().length > 0 &&
    Array.isArray(record.keywords) &&
    record.keywords.every((k) => typeof k === "string" && k.trim() === k && k.length > 0) &&
    typeof record.createdAt === "string" && ISO_RE.test(record.createdAt) &&
    typeof record.cwd === "string" && isAbsolute(record.cwd);
}

export function readMemory(path) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return validRecord(record, path) ? record : null;
  } catch {
    return null;
  }
}

function coverage(queryTokens, value) {
  if (!queryTokens.length) return 0;
  const haystack = new Set(tokens(value));
  return queryTokens.filter((token) => haystack.has(token)).length / queryTokens.length;
}

function scoreRecord(record, query) {
  const q = String(query ?? "").trim().toLocaleLowerCase();
  const qTokens = tokens(q);
  if (!q) return 0;
  const keywordText = record.keywords.join(" ");
  const idScore = coverage(qTokens, record.id);
  const titleScore = coverage(qTokens, record.title);
  const keywordScore = coverage(qTokens, keywordText);
  const bodyScore = coverage(qTokens, record.body);
  const cwdScore = coverage(qTokens, record.cwd);
  const phrase = record.title.toLocaleLowerCase().includes(q) ? 2
    : keywordText.toLocaleLowerCase().includes(q) ? 0.75
      : record.body.toLocaleLowerCase().includes(q) ? 0.5
        : record.cwd.toLocaleLowerCase().includes(q) ? 0.25 : 0;
  const score = idScore * 5 + titleScore * 4 + keywordScore * 3 +
    bodyScore * 2 + cwdScore + phrase;
  return score > 0 ? score : 0;
}

export function searchMemories(query, { home = homedir(), limit = 6 } = {}) {
  let names;
  try {
    names = readdirSync(memoryDir(home)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const hits = [];
  for (const name of names) {
    const path = join(memoryDir(home), name);
    const record = readMemory(path);
    if (!record) continue;
    const score = scoreRecord(record, query);
    if (score > 0) hits.push({ ...record, path, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Number(limit) || 6));
}

async function withStoreLock(home, fn) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await Lock.withLock(memoryLockPath(home), fn);
    if (result !== null) return result;
    await delay(Math.min(5 + attempt * 2, 50));
  }
  throw new Error("manual memory store is busy; retry kb_insert");
}

export async function insertMemory({
  title, body, keywords = [], cwd = process.cwd(), home = homedir(),
  now = () => new Date(), idFactory = randomUUID,
}) {
  if (typeof title !== "string" || !title.trim() ||
      typeof body !== "string" || !body.trim()) {
    throw new Error("title and body are required non-empty strings");
  }
  const cleanKeywords = normalizedKeywords(keywords);
  if (containsSecret([title, body, ...cleanKeywords].join("\n"))) {
    throw new Error("refusing to store secret-shaped content");
  }
  const id = `mem-${String(idFactory()).replace(/^mem-/, "")}`;
  if (!ID_RE.test(id)) {
    throw new Error("failed to allocate a valid manual memory id");
  }
  const record = {
    schema: MEMORY_SCHEMA, id, title, body,
    keywords: cleanKeywords, createdAt: now().toISOString(), cwd: resolve(cwd),
  };
  const path = await withStoreLock(home, () => {
    const dir = memoryDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const target = join(dir, `${id}.json`);
    if (existsSync(target)) throw new Error("manual memory id already exists");
    const temp = join(dir, `.${id}.${process.pid}.tmp`);
    let fd = null;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeSync(fd, JSON.stringify(record, null, 2) + "\n", null, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, target);
      chmodSync(target, 0o600);
      if (process.platform !== "win32") {
        const dirFd = openSync(dir, "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
      return target;
    } finally {
      if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temp); } catch { /* renamed or never created */ }
    }
  });
  const reopened = readMemory(path);
  if (!reopened || reopened.body !== body || reopened.id !== id) {
    throw new Error("manual memory failed durable read-back verification");
  }
  const searchable = searchMemories(id, { home, limit: 1 }).some((hit) => hit.id === id);
  if (!searchable) throw new Error("manual memory failed lexical search verification");
  return { id, path, title, searchable: true };
}
