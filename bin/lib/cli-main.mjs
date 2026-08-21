// cli-main.mjs — heimdall CLI dispatch. Thin wrappers over existing scripts.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)); // bin/lib
const ROOT = dirname(dirname(HERE)); // repo root
const BIN = (n) => join(ROOT, "bin", n);
const USAGE = `usage: heimdall <command>

  init [--harness pi|claude-code|codex|cursor|windsurf|all]   configure backend + harness hooks
  search "<query>" [-n N] [--scope S] [--no-explore]          ranked + verified knowledge search
  insert --title T --body B [--keywords k1,k2]                record reusable knowledge
  doctor                                                      daemon + index health check
`;

const sh = (script, args) =>
  spawnSync("bash", [script, ...args], { stdio: "inherit" }).status ?? 1;

function runSearch(args) {
  return sh(BIN("kb-search.sh"), args);
}

function runInsert(args) {
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
  const graft = process.env.GRAFT || join(os.homedir(), ".local", "bin", "graft");
  const kwArgs = kws.flatMap((k) => ["--keyword", k]);
  execFileSync(graft, ["insert", "--title", title, "--body", body, ...kwArgs], { stdio: "inherit" });
  return 0;
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

import { installAdapter } from "./adapters.mjs";

function runInit(args) {
  const i = args.indexOf("--harness");
  const harness = i >= 0 ? args[i + 1] : "pi";
  const valid = ["pi", "claude-code", "codex", "cursor", "windsurf", "all"];
  if (!valid.includes(harness)) {
    console.error(`invalid --harness ${harness} (choose: ${valid.join("|")})`);
    return 1;
  }
  const existed = existsSync(configPath());
  writeConfig(harness);
  const installed = installAdapter(harness);
  console.log(
    existed
      ? `ok: config already present, harness set to ${harness}`
      : `ok: wrote ${configPath()} (harness: ${harness})`,
  );
  console.log(`adapter: ${JSON.stringify(installed)}`);
  console.log("backend: graft (vendored in package; daemon starts on first use)");
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init": return runInit(rest);
    case "search": return runSearch(rest);
    case "insert": return runInsert(rest);
    case "doctor": return runDoctor();
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
