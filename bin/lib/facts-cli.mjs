#!/usr/bin/env node
// facts-cli.mjs — thin CLI shim over extractFacts for the bench (spec D3:
// ONE extractor implementation, consumed as a subprocess — never re-implemented).
// Contract: `facts-cli.mjs --file <path>` prints ONE JSON fact array on stdout
// and nothing else; any problem goes to stderr with a nonzero exit.
import { readFileSync, readdirSync } from "node:fs";
import { extractFacts } from "./facts.mjs";

const fail = (msg) => {
  console.error(`facts-cli: ${msg}`);
  console.error("usage: facts-cli.mjs --file <prompt-log-or-notes-path>");
  process.exit(1);
};

const args = process.argv.slice(2);
let file;
let dir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file") file = args[++i];
  else if (args[i] === "--dir") dir = args[++i];
  else fail(`unknown argument: ${args[i]}`);
}
if (!file && !dir) fail("missing --file <path> or --dir <path>");

const { } = {};
// Batch mode: --dir processes every file in one node invocation (fast ingest).
// extractFacts is a pure function of (bytes, path), so batching is parity-safe.
// The bench writes sessions under <root>/<qid>/session_*.md, so scan one level
// deep and flatten: key = <qid>/<file> (matches the source-relative path).
if (dir) {
  const out = {};
  const qids = readdirSync(dir).filter((f) => !f.startsWith("."));
  for (const qid of qids) {
    const qdir = `${dir}/${qid}`;
    let files;
    try {
      files = readdirSync(qdir).filter((f) => !f.startsWith("."));
    } catch {
      continue; // not a dir
    }
    for (const f of files) {
      const p = `${qdir}/${f}`;
      let b;
      try {
        b = readFileSync(p);
      } catch {
        continue;
      }
      out[`${qid}/${f}`] = extractFacts(b, { path: p });
    }
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

let buf;
try {
  buf = readFileSync(file);
} catch (e) {
  fail(`cannot read ${file}: ${e.code ?? e.message}`);
}

process.stdout.write(JSON.stringify(extractFacts(buf, { path: file })) + "\n");
