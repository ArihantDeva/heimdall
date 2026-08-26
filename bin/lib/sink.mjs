// sink.mjs — the graph backend as a projection target.
//
// The journal is authoritative; a sink is a rebuildable view of it. Keeping
// this behind an interface is what lets the invariant tests run without a
// graft daemon, and is what makes "backends are pluggable" true in practice
// rather than as an aspiration.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** Graft-backed sink (NanoNets per-repo graph).
 *
 * WRITE/RETRIEVE SPLIT (intentional; end-to-end proof lives in
 * tests/e2e-fixture.test.mjs): the journal is the authoritative index of what
 * should exist; `graft build` is a separate idempotent projection step that
 * regenerates each watched repo's graph from disk (run by `index-bootstrap`
 * / `heimdall index`, not per insert). Retrieval runs `graft ask --json` per
 * repo (see kb-search.sh). Consequence: insert() returns a deterministic
 * content-hash id and performs no I/O — durability comes from the journal,
 * visibility comes from the next build.
 */
export class GraftSink {
  constructor(bin = process.env.GRAFT || join(homedir(), ".local", "bin", "graft")) {
    this.bin = bin;
  }
  get available() {
    return existsSync(this.bin);
  }
  insert({ title, body, keywords = [] }) {
    // Per-repo graph: build reflects the journal; the node id is a stable
    // hash of the rendered body so deletes can target it. We do NOT call
    // `graft insert` (that API no longer exists in the npm product).
    const id = "g" + createHash("sha256").update(body).digest("hex").slice(0, 16);
    return id;
  }
  delete(id) {
    // The per-repo graph rebuilds from source; deletes are handled by
    // `graft build` regeneration, not per-node calls.
    return;
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
