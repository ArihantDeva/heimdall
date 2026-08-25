// ingest-email.mjs — native CPU-only email ingestion pathway.
//
// Reads mail EXCLUSIVELY through the local cli-email binary (read-only
// subcommands: `list`, `show` — never send/mark/move), renders one graft-style
// markdown card per message under <root>/graft/mail/<account>/<uid>.md, and
// lets Heimdall's existing primitives do the rest: embed-index.py already
// discovers any ~/Repos/*/graft/**/*.md, kb-search.sh merges those hits, and
// the reconciler treats the cards as ordinary files. No new index store, no
// network beyond IMAP reads via cli-email, no GPU: embeddings run through the
// existing CPU-only bge-m3 layer during `heimdall index`.
//
// The runner is an injected capability ({run(sub, args) -> stdout string}) so
// tests never touch a real mailbox and business logic never constructs the
// CLI inline. Idempotent by content: a card is rewritten only when its bytes
// change, so re-runs are cheap no-ops.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EMAIL_CLI = join(homedir(), "Repos", "cli-email", ".venv", "bin", "email");

/** Read-only subcommands this module may ever invoke. Guard, not convention. */
const ALLOWED = new Set(["list", "show"]);

/**
 * Extract the first JSON value (array or object) from stdout that may carry
 * cli-email progress noise before the payload. Returns [] when nothing parses.
 */
export function parseEmailJson(stdout) {
  const s = String(stdout ?? "");
  const starts = [...s].flatMap((ch, i) => (ch === "[" || ch === "{") ? [i] : []);
  for (const i of starts) {
    try {
      const v = JSON.parse(s.slice(i));
      if (Array.isArray(v) || (v && typeof v === "object")) return v;
    } catch {
      // mid-string bracket that isn't the payload; keep scanning
    }
  }
  return [];
}

/** list responses wrap messages in {results}; show returns a bare array. */
const toMessages = (v) => (Array.isArray(v) ? v : Array.isArray(v?.results) ? v.results : []);

const addr = (a) => (a ? [a.name, a.email].filter(Boolean).join(" ") : "unknown");
const clean = (s) => String(s ?? "").replace(/\r\n?/g, "\n").trimEnd();

/**
 * Render one email into its card. Deterministic pure function of the message:
 * same message in, identical bytes out — that property is what makes re-ingest
 * idempotent without any cursor bookkeeping.
 */
export function renderEmailCard(msg) {
  const body = clean(msg.body ?? msg.body_preview ?? "");
  const md = [
    `# ${clean(msg.subject || "(no subject)")}`,
    "",
    `- From: ${addr(msg.sender)}
- Subject: ${clean(msg.subject || "(no subject)")}`,
    `- To: ${(msg.to ?? []).map(addr).join(", ") || "unknown"}`,
    `- Date: ${msg.date ?? "unknown"}`,
    `- Account: ${msg.account ?? "?"} · UID ${msg.uid}`,
    "",
    body,
    "",
  ].join("\n");
  return { relPath: `mail/${msg.account}/${msg.uid}.md`, markdown: md };
}

/**
 * Ingest one account's recent INBOX mail into cards. Read-only against the
 * mailbox: only `list` and `show` are legal here (ALLOWED guards it).
 *
 * @param {{accounts?: string[], limit?: number, root?: string,
 *          run: (sub: string, args: string[]) => string}} opts
 * @returns {Promise<{fetched: number, written: number}>}
 */
export async function ingestEmail({ accounts = [], limit = 50, root, run }) {
  const graftDir = join(root, "graft");
  let written = 0;
  let fetched = 0;
  for (const account of accounts) {
    const listed = toMessages(parseEmailJson(run("list", ["-a", account, "--limit", String(limit), "--format", "json"])));
    for (const meta of listed) {
      fetched++;
      const full = toMessages(parseEmailJson(run("show", [String(meta.uid), "-a", account, "--format", "json"])));
      const found = full.find((m) => String(m.uid) === String(meta.uid)) ?? {};
      // show responses may carry account:null — the listing's account wins.
      const msg = { ...meta, ...found, account: found.account ?? meta.account ?? account };
      const { relPath, markdown } = renderEmailCard(msg);
      const file = join(graftDir, relPath);
      mkdirSync(join(graftDir, "mail", String(msg.account)), { recursive: true });
      // Byte-compare before writing: unchanged messages must not bump mtime,
      // so downstream embed/reconcile layers see a stable tree.
      try {
        if (readFileSync(file, "utf8") === markdown) continue;
      } catch {
        // absent → fall through to write
      }
      writeFileSync(file, markdown);
      written++;
    }
  }
  return { fetched, written };
}
