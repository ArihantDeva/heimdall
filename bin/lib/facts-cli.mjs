#!/usr/bin/env node
// facts-cli.mjs — thin CLI shim over extractFacts for the bench (spec D3:
// ONE extractor implementation, consumed as a subprocess — never re-implemented).
// Contract: `facts-cli.mjs --file <path>` prints ONE JSON fact array on stdout
// and nothing else; any problem goes to stderr with a nonzero exit.
import { readFileSync } from "node:fs";
import { extractFacts } from "./facts.mjs";

const fail = (msg) => {
  console.error(`facts-cli: ${msg}`);
  console.error("usage: facts-cli.mjs --file <prompt-log-or-notes-path>");
  process.exit(1);
};

const args = process.argv.slice(2);
let file;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file") file = args[++i];
  else fail(`unknown argument: ${args[i]}`);
}
if (!file || file.startsWith("-")) fail("missing --file <path>");

let buf;
try {
  buf = readFileSync(file);
} catch (e) {
  fail(`cannot read ${file}: ${e.code ?? e.message}`);
}

process.stdout.write(JSON.stringify(extractFacts(buf, { path: file })) + "\n");
