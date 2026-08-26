#!/usr/bin/env node
// Internal JSON bridge used by kb-search.sh for the immediate memory lane.
import { searchMemories } from "./lib/manual-memory.mjs";

const [command, query = "", limit = "6"] = process.argv.slice(2);
if (command !== "search" || !query.trim()) {
  console.error("usage: manual-memory.js search <query> [limit]");
  process.exitCode = 2;
} else {
  const hits = searchMemories(query, { limit: Math.max(1, Number(limit) || 6) });
  process.stdout.write(JSON.stringify({ hits }) + "\n");
}
