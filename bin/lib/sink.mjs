// sink.mjs — the graph backend as a projection target.
//
// The journal is authoritative; a sink is a rebuildable view of it. Keeping
// this behind an interface is what lets the invariant tests run without a
// graft daemon, and is what makes "backends are pluggable" true in practice
// rather than as an aspiration.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** In-memory sink. Used by tests and by `--dry-run`. */
export class MemorySink {
  constructor() {
    this.nodes = new Map(); // sink_id -> {title, body, keywords}
    this.seq = 0;
    this.ops = [];
  }
  get available() { return true; }
  insert({ title, body, keywords = [] }) {
    const id = `mem${++this.seq}`;
    this.nodes.set(id, { title, body, keywords });
    this.ops.push(["insert", id, title]);
    return id;
  }
  delete(id) {
    this.nodes.delete(id);
    this.ops.push(["delete", id]);
  }
}

/** Graft-backed sink. */
export class GraftSink {
  constructor(bin = process.env.GRAFT || join(homedir(), ".local", "bin", "graft")) {
    this.bin = bin;
  }
  get available() {
    return existsSync(this.bin);
  }
  insert({ title, body, keywords = [] }) {
    const args = ["insert", "--title", title, "--body", body];
    for (const k of keywords) args.push("--keyword", k);
    const out = execFileSync(this.bin, args, { encoding: "utf8", timeout: 30_000 });
    // graft prints the new node id; accept either bare hex or JSON.
    const hex = out.match(/\b([0-9a-fA-F]{16,})\b/);
    if (hex) return hex[1];
    try {
      const j = JSON.parse(out);
      return j.result?.id_hex ?? j.id_hex ?? null;
    } catch {
      return null;
    }
  }
  delete(id) {
    if (!id) return;
    try {
      execFileSync(this.bin, ["delete", id], { stdio: "ignore", timeout: 30_000 });
    } catch {
      // Already gone is success for our purposes: the desired state is absence.
    }
  }
}

/**
 * Render a journal node into the sink's title/body form.
 * Symbol nodes carry file:line so a search hit points at the definition.
 */
export function renderNode(n, path) {
  if (n.kind === "file") {
    return {
      title: path,
      body: `${path}${n.language ? ` — ${n.language}` : ""}`,
      keywords: ["heimdall", "file", n.language].filter(Boolean),
    };
  }
  // Fact nodes arrive fully rendered by the extractor (facts.mjs contract:
  // title/body/keywords) — pass straight through so graft ranks the utterance,
  // not the file it came from.
  if (n.kind === "fact") {
    return {
      title: n.title ?? "fact",
      body: n.body ?? n.title ?? "",
      keywords: n.keywords?.length ? n.keywords : ["heimdall", "fact"],
    };
  }
  const where = n.line ? `${path}:${n.line}` : path;
  return {
    title: `${n.label ?? n.symbol} — ${where}`,
    body: `${n.label ?? n.symbol} defined at ${where}`,
    keywords: ["heimdall", "symbol"],
  };
}
