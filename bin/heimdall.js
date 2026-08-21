#!/usr/bin/env node
// heimdall.js — npm CLI entrypoint. Wraps the repo's bin/ scripts; wraps, does
// not rewrite. Subcommands: init, search, insert, doctor.
import { main } from "./lib/cli-main.mjs";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err && err.message || err));
    process.exit(1);
  },
);
