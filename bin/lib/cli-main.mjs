// cli-main.mjs — heimdall CLI dispatch. Thin wrappers over existing scripts.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)); // bin/lib
const ROOT = dirname(dirname(HERE)); // repo root
const BIN = (n) => join(ROOT, "bin", n);
const USAGE = `usage: heimdall <command>

  init [--harness pi|claude-code|codex|cursor|windsurf|all]   configure backend + harness hooks
  setup [--model ID | --model-path F] [--threads N] [--instances N]      hardware-fit graft config + daemon
        [--accel auto|metal|cuda|cpu] [--graftd PATH] [--skip-daemon] [--detect-only]
  search "<query>" [-n N] [--scope S] [--no-explore]          ranked + verified knowledge search
  insert --title T --body B [--keywords k1,k2]                record reusable knowledge
  ingest-email [--accounts a,b] [--limit N] [--root DIR]      index mailbox (read-only via cli-email)
  doctor                                                      daemon + index health check

  daemon [--once] [--scan] [--dry-run]                        run the single-writer reconciler
  reconcile [PATH ...] [--all]                                converge the graph now (holds the lock)
  verify [--deep] [--json]                                    report drift; exit 1 if any. read-only
  history PATH                                                archived fact rows for PATH, newest first. READ-ONLY
                                                              record: not advice — every row is already invalidated
  score [--count-only]                                        graded health 0-100 from drift + stale counts; exit 1 if critical
  depth [PATH]                                                show requested/effective depth
  hint PATH ... | hint --stdin                                mark paths dirty (no lock needed)
`;

const sh = (script, args) =>
  spawnSync("/bin/bash", [script, ...args], { stdio: "inherit" }).status ?? 1;

// Expand a leading ~/ — resolve() alone yields a literal "$HOME/~" path, which
// reconcile then records absent even though the real file exists.
const expandPath = (p) =>
  p.startsWith("~/") ? join(os.homedir(), p.slice(2)) : p;

// Reject flags a subcommand does not know. Silent acceptance turned
// `verify --deeph` into a plain `verify` — the user thinks deep audit ran.
function checkFlags(cmd, args, allowed) {
  const bad = args.filter((a) => a.startsWith("--") && !allowed.includes(a));
  if (!bad.length) return 0;
  for (const b of bad) console.error(`unknown option for ${cmd}: ${b}`);
  console.error(USAGE);
  return 2;
}

function runSearch(args) {
  return sh(BIN("kb-search.sh"), args);
}
async function runInsert(args) {
  const get = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : "";
  };
  const title = get("--title");
  const body = get("--body");
  const kws = (get("--keywords") || "").split(",").filter(Boolean);
  if (!title || !body) {
    console.error("usage: heimdall insert --title T --body B [--keywords k1,k2]");
    return 1;
  }
  // Materialize the fact where retrieval can see it: a markdown card under
  // ~/heimdall-notes/facts/ (inside $HOME, outside any repo source tree, so
  // graft builds and the embed walker both pick it up). The journal hint is
  // still emitted for reconciliation, but the file IS the durable record —
  // the old cwd-relative .fact.md target was never written by anything.
  const FACTS_DIR = join(os.homedir(), "heimdall-notes", "facts");
  let factPath = "";
  try {
    mkdirSync(FACTS_DIR, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    const stamp = new Date().toISOString().slice(0, 10);
    factPath = join(FACTS_DIR, `${stamp}-${slug || "fact"}.md`);
    const kw = kws.length ? `keywords: ${kws.join(", ")}\n` : "";
    const card = `# ${title}\n\n${kw}\n${body}\n\n(recorded ${new Date().toISOString()})\n`;
    writeFileSync(factPath, card, "utf8");
    console.log(`fact recorded: ${factPath}`);
    // Immediate semantic visibility: upsert just this card into the live
    // index (cheap single encode). Venv absence (Linux/0.7.0, issue #7) must
    // never lose the fact — the file above is already durable; this only
    // accelerates retrieval.
    const venvPy = join(os.homedir(), ".heimdall", "venv", "bin", "python3");
    if (existsSync(venvPy)) {
      try {
        spawnSync(venvPy,
                  [BIN("embed-index.py"), "insert-card", factPath], { stdio: "ignore", timeout: 120_000 });
      } catch (e) {
        console.error(`WARN: semantic indexing of fact deferred (lands on next embed build): ${e.message?.split("\n")[0] ?? e}`);
      }
    } else {
      console.log("note: no ~/.heimdall venv — fact saved to disk; it will be indexed on the next embed build");
    }
  } catch (e) {
    console.error(`ERROR: could not write fact: ${e.message?.split("\n")[0] ?? e}`);
    return 1;
  }
  // Journal intent for the reconciler (unchanged contract).
  try {
    const { emitHint } = await import("./hints.mjs");
    const { queueHintPath } = await import("./depth.mjs");
    const hintFile = queueHintPath();
    emitHint(hintFile, factPath, "insert:" + title);
  } catch (e) {
    console.error(`ERROR: hint failed: ${e.message?.split("\n")[0] ?? e}`);
    return 1;
  }
  return 0;
}

function runIndexCmd(args) {
  const json = args.includes("--json");
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
  return import("./index-bootstrap.mjs").then(({ runIndex }) => {
    const { repos, embed } = runIndex({ root });
    if (json) {
      console.log(JSON.stringify({ repos, embed }, null, 2));
      return 0;
    }
    for (const r of repos) console.log(`  ${r.status.padEnd(7)} ${r.repo}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log(embed);
    if (!repos.length) console.log("(no git repos found)");
    return 0;
  });
}

function runDoctor() {
  return sh(BIN("kb-health.sh"), []);
}

function configPath() {
  return join(os.homedir(), ".heimdall", "config.json");
}

function writeConfig(harness) {
  mkdirSync(dirname(configPath()), { recursive: true });
  const cfg = existsSync(configPath())
    ? JSON.parse(readFileSync(configPath(), "utf8"))
    : { version: 1 };
  cfg.harness = harness;
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

import { installAdapter, detectHarnesses, KNOWN_HARNESSES } from "./adapters.mjs";
const adaptersModule = () => ({ installAdapter, detectHarnesses, KNOWN_HARNESSES });

function runInit(args) {
  if (args.includes("--detect")) {
    const { detectHarnesses } = adaptersModule();
    const found = detectHarnesses();
    console.log(found.length ? found.join("\n") : "(no harness configs found)");
    return 0;
  }
  const i = args.indexOf("--harness");
  const harness = i >= 0 ? args[i + 1] : "pi";
  const valid = [...adaptersModule().KNOWN_HARNESSES, "all"];
  if (!valid.includes(harness)) {
    console.error(`invalid --harness ${harness} (choose: ${valid.join("|")})`);
    return 1;
  }
  const quiet = args.includes("--quiet");
  const existed = existsSync(configPath());
  writeConfig(harness);
  const installed = installAdapter(harness);
  if (quiet) {
    // one name per line, machine-readable for postinstall
    const names = Array.isArray(installed) ? installed : [installed];
    console.log(names.map((r) => String(r).split(" ")[0]).join("\n"));
    return 0;
  }
  console.log(
    existed
      ? `ok: config already present, harness set to ${harness}`
      : `ok: wrote ${configPath()} (harness: ${harness})`,
  );
  console.log(`adapter: ${JSON.stringify(installed)}`);
  console.log(
    "backend: @nanonets/graft (npm) — install with: npm i -g @nanonets/graft, then: heimdall doctor",
  );
  return 0;
}

// ── self-healing surface ───────────────────────────────────────────────────
// Every one of these goes through the same reconcile path the daemon uses.
// There is deliberately no "update node X" command: the only way to change the
// graph is to change a file and let the reconciler observe it.

async function runDaemon(args) {
  const { runDaemon: run } = await import("../heimdall-reconciler.mjs");
  return run(args, { log: console.error });
}

async function runReconcile(args) {
  // Paths and --all/--dry-run only. A typo'd --alll must not silently become a
  // full deep audit + repair.
  const bad = checkFlags("reconcile", args, ["--all", "--dry-run"]);
  if (bad) return bad;
  const [{ Journal }, { Lock }, { drain, audit, skipPath }, { GraftSink, MemorySink },
    { capability, journalPath, loadConfig, lockPath, queueHintPath }, { ingestHints }] =
    await Promise.all([
      import("./journal.mjs"), import("./lock.mjs"), import("./reconcile.mjs"),
      import("./sink.mjs"), import("./depth.mjs"), import("./hints.mjs"),
    ]);
  const all = args.includes("--all");
  const dry = args.includes("--dry-run");
  const paths = args.filter((a) => !a.startsWith("--")).map((p) => resolve(process.cwd(), expandPath(p)));

  const code = await Lock.withLock(lockPath(), () => {
    const journal = new Journal(journalPath());
    const ctx = {
      journal, config: loadConfig(), cap: capability(),
      sink: dry ? new MemorySink() : new GraftSink(),
    };
    try {
      // Drain whatever hooks and scripts have hinted since the last pass. A
      // one-shot run is the whole self-healing story on a machine with no
      // daemon, so it must consume the same inbox the daemon does.
      ingestHints(queueHintPath(), journal, { skip: (p) => skipPath(p, os.homedir()) });
      if (all) audit(ctx, { deep: true });
      for (const p of paths) {
        if (skipPath(p, os.homedir())) { console.error(`skip ${p}`); continue; }
        journal.enqueue(p, "cli");
      }
      let total = 0;
      for (;;) {
        const { processed } = drain(ctx);
        if (!processed) break;
        total += processed;
      }
      console.log(`reconciled ${total} path(s); ${JSON.stringify(journal.stats())}`);
      return 0;
    } finally {
      journal.close();
    }
  });
  if (code === null) {
    console.error("another writer holds the reconciler lock (is the daemon running?)");
    return 1;
  }
  return code;
}

async function runVerify(args) {
  const bad = checkFlags("verify", args, ["--deep", "--json"]);
  if (bad) return bad;
  const [{ Journal }, { audit }, { MemorySink }, { capability, journalPath, loadConfig }] =
    await Promise.all([
      import("./journal.mjs"), import("./reconcile.mjs"),
      import("./sink.mjs"), import("./depth.mjs"),
    ]);
  const journal = new Journal(journalPath());
  try {
    // Read-only: never enqueues, never writes the sink. Safe to run alongside
    // the daemon, and safe to put in CI.
    const drift = audit(
      { journal, sink: new MemorySink(), config: loadConfig(), cap: capability() },
      { deep: args.includes("--deep"), enqueue: false },
    );
    const stats = journal.stats();
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok: drift.length === 0, drift, stats }, null, 2));
    } else if (drift.length) {
      for (const d of drift) console.log(`DRIFT ${d.why}\t${d.path}`);
      console.log(`\n${drift.length} drifted path(s) of ${stats.paths}. Run: heimdall reconcile --all`);
    } else {
      console.log(`ok: ${stats.paths} paths, ${stats.nodes} nodes, ${stats.edges} edges, ` +
        `${stats.pending} pending, ${stats.queued} queued — no drift`);
    }
    return drift.length ? 1 : 0;
  } finally {
    journal.close();
  }
}

// Graded health score (C4, scoring half): pure arithmetic over issue counts.
// Read-only like verify — no repair gating, no deletion decisions. Exit 1 only
// when the band is critical, so CI can alert without any auto-repair loop.
async function runScore(args) {
  const bad = checkFlags("score", args, ["--count-only"]);
  if (bad) return bad;
  const { computeHealthScore, classifyDrift } = await import("./health-score.mjs");
  const [{ Journal }, { audit }, { MemorySink }, { capability, journalPath, loadConfig }] =
    await Promise.all([
      import("./journal.mjs"), import("./reconcile.mjs"),
      import("./sink.mjs"), import("./depth.mjs"),
    ]);
  const journal = new Journal(journalPath());
  try {
    // Same read-only audit shape as `verify`: stat-only unless --deep is ever
    // added; never enqueues, never writes the sink.
    const drift = audit(
      { journal, sink: new MemorySink(), config: loadConfig(), cap: capability() },
      { deep: false, enqueue: false },
    );
    const stale = countStale();
    const counts = classifyDrift(drift);
    // Fail-CLOSED on sensor loss (C4 review F1): a dead stale-scan must NOT
    // raise the score by dropping its warnings. Count the missing reading as
    // one warning and surface it explicitly.
    const staleWarn = stale ? stale.stale : 0;
    const staleIssue = stale ? 0 : 1;
    const { score, band } = computeHealthScore({
      errors: counts.errors,
      warnings: counts.warnings + staleWarn + staleIssue,
      infos: counts.infos,
    });
    const out = {
      score, band,
      issues: { ...counts, staleNodesPending: stale?.stale ?? null, staleNodesTotal: stale?.nodes ?? null,
        staleScanFailed: !stale },
    };
    console.log(JSON.stringify(out, null, 2));
    return band === "critical" ? 1 : 0;
  } finally {
    journal.close();
  }
}

// Stale-node counters via kb-stale-scan.py --count-only (read-only sweep, no
// find/rehome/delete). Absent DB → zero stale nodes counted, daemon liveness
// must not masquerade as graph decay. Returns null when the scan itself fails
// — caller scores that fail-closed (C4 review F1).
function countStale() {
  const r = spawnSync(
    "python3", [BIN("kb-stale-scan.py"), "--count-only"],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.error(`WARN: stale scan unavailable (${(r.stderr || "").trim().split("\n")[0]}); scoring drift rows only (+1 warning for the dead sensor)`);
    return null;
  }
  try { return JSON.parse(r.stdout); } catch { return null; }
}

async function runIngestEmail(args) {
  const get = (f, dflt) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  const accounts = get("--accounts", "").split(",").filter(Boolean);
  const limit = Number(get("--limit", "50"));
  const root = resolve(process.cwd(), expandPath(get("--root", join("Repos", "email-archive"))));
  const { ingestEmail, EMAIL_CLI } = await import("./ingest-email.mjs");
  const { spawnSync } = await import("node:child_process");
  // Read-only boundary: only list/show ever reach cli-email.
  const run = (sub, subArgs) => {
    const r = spawnSync(EMAIL_CLI, [sub, ...subArgs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    return r.stdout ?? "";
  };
  try {
    const summary = await ingestEmail({ accounts, limit, root, run });
    console.log(`ingest-email: fetched ${summary.fetched}, wrote ${summary.written} card(s) under ${join(root, "graft")}`);
    console.log("next: heimdall index   # embed cards into the global semantic layer (CPU-only)");
    return 0;
  } catch (e) {
    console.error(`ingest-email failed: ${e.message?.split("\n")[0] ?? e}`);
    return 1;
  }
}

// ── fact history (C3) ──────────────────────────────────────────────────────
// Read-only audit surface over the journal's fact_history table. This is a
// RECORD of invalidated beliefs, not advice: every row printed here has been
// retracted from the live graph. The [INVALIDATED] prefix and the footer make
// that output contract unmissable — never act on these as current state.
async function runHistory(args) {
  const bad = checkFlags("history", args, []);
  if (bad) return bad;
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: heimdall history PATH");
    return 1;
  }
  const path = resolve(process.cwd(), expandPath(target));
  const { Journal } = await import("./journal.mjs");
  const { journalPath } = await import("./depth.mjs");
  const journal = new Journal(journalPath());
  try {
    const rows = journal.factHistory(path);
    if (!rows.length) {
      console.log(`no fact history for ${path}`);
      return 0;
    }
    for (const r of rows) {
      const sup = r.superseded_by ? ` (superseded by ${r.superseded_by})` : "";
      console.log(`[INVALIDATED] ${r.invalidated_at}\t${r.node_id}\tline ${r.line ?? "?"}${sup}`);
      // v3 journals archive the fact text (C3 review B1); pre-v3 rows have
      // nothing to show — the opaque id is all that survives.
      if (r.fact_title) console.log(`  was: ${r.fact_title}`);
      if (r.fact_body) console.log(`  ${r.fact_body.replace(/\n/g, " ⏎ ").slice(0, 300)}`);
    }
    // The output contract, stated where it cannot be skipped:
    console.log(`\n${rows.length} archived row(s) for ${path} — history is a record, not advice; none of the above is currently believed.`);
    return 0;
  } finally {
    journal.close();
  }
}

async function runDepth(args) {
  const bad = checkFlags("depth", args, []);
  if (bad) return bad;
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) return 0;
  const p = resolve(process.cwd(), expandPath(target));
  const { capability, depthFor, loadConfig } = await import("./depth.mjs");
  const cap = capability();
  console.log(`capability: ${cap.max} (${cap.reason})`);
  const d = depthFor(p, loadConfig(), cap);
  console.log(`${p}\n  requested: ${d.requested}\n  effective: ${d.effective}${d.clamped ? "  (clamped by capability)" : ""}`);
  return 0;
}

async function runHint(args) {
  const [{ emitHint }, { queueHintPath }] = await Promise.all([
    import("./hints.mjs"), import("./depth.mjs"),
  ]);
  const paths = args.filter((a) => !a.startsWith("--"));
  // --stdin: harness hooks (Claude Code PostToolUse) hand us the tool call as
  // JSON on stdin. We pull every string that looks like a path out of it rather
  // than depending on one schema — a false positive costs one stat, a missed
  // path costs accuracy until the next audit.
  if (args.includes("--stdin")) {
    let raw = "";
    try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    for (const m of raw.matchAll(/"((?:\/|~\/)[^"\\]{1,4096})"/g)) {
      paths.push(m[1].startsWith("~/") ? join(os.homedir(), m[1].slice(2)) : m[1]);
    }
  }
  if (!paths.length) {
    if (args.includes("--stdin")) return 0; // nothing path-like; not an error
    console.error("usage: heimdall hint PATH ... | heimdall hint --stdin");
    return 1;
  }
  const hintFile = queueHintPath();
  const seen = new Set();
  for (const p of paths) {
    const abs = resolve(process.cwd(), expandPath(p));
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) {
      // Advisory by design — the reconciler will record it absent. But silence
      // reads like success on a typo'd path, so say what will happen.
      console.error(`hinted: ${abs} (path does not exist — will reconcile as absent)`);
    }
    emitHint(hintFile, abs, "cli");
  }
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init": return runInit(rest);
    case "setup": return (await import("./setup.mjs")).runSetup(rest);
    case "daemon": return runDaemon(rest);
    case "reconcile": return runReconcile(rest);
    case "verify": return runVerify(rest);
    case "history": return await runHistory(rest);
    case "score": return await runScore(rest);
    case "depth": return runDepth(rest);
    case "hint": return runHint(rest);
    case "search": return runSearch(rest);
    case "insert": return await runInsert(rest);
    case "ingest-email": return await runIngestEmail(rest);
    case "doctor": return runDoctor();
    case "index": return runIndexCmd(rest);
    case "mcp": return (await import("./mcp-server.mjs")).serveMcp().then(() => 0);
    case undefined:
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      return 1;
  }
}
