// facts.mjs — desired fact-state for one prompt-log or notes file. Spec:
// docs/superpowers/specs/2026-08-23-fact-layer-design.md §Extraction.
//
// Pure function of (bytes, source path): the same buffer always produces the
// same fact array, ids included. That property is what makes reconcile
// idempotent — re-extract + owned-node commit converges instead of drifting —
// and therefore why nothing here reads the clock, the environment, or any
// other file. CPU-only by decision D2: no LLM, no network at ingest.
import { createHash } from "node:crypto";

const MAX_TITLE = 120;

// Secret classes hard-skipped BEFORE any storage (trust boundary, D5 — not a
// preference). Matched secret content is never logged anywhere: the counter
// in meta.skippedSecrets is the only observable trace.
const SECRET_RES = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{12,}\b/,
  /\bBearer\s+\S+/i,
  /\bbearer\s+[A-Za-z0-9._-]{20,}/,
  /\bpassword\s*=/i,
  /\b[a-f0-9]{20,}\b/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

const isSecret = (s) => SECRET_RES.some((re) => re.test(s));

// Exported (2026-09-28 retrieval spec, P4/P6) so the people store reuses the
// SAME normalizer and the SAME secret screen rather than declaring a second
// copy. The 2026-08-23 spec's D3 is explicit that two implementations drift, and
// a second secret regex is a trust-boundary bug waiting to happen.

// Ordered fact patterns over one normalized utterance. First match wins kind,
// so the order below IS the precedence: preferences outrank generic
// assertions, declarations outrank bare negations.
// ponytail: English-only patterns — deliberate recall ceiling per spec
// ("non-English: no match → zero facts, acceptable"); upgrade path is extra
// pattern packs behind this same table, never a second extractor.
// `declaration` carries only HALF its proposition in group 1 — "X is Y" puts
// the subject in g1 and the predicate in g2. Every other pattern captures the
// whole utterance in g1. So the picker below is what keeps declaration facts
// complete: without it the predicate is dropped before construction, and
// "X is allowed" / "X is not allowed" collapse into one identical truncated
// fact at the dedup gate.
const PATTERNS = [
  { kind: "preference", re: /\b(i\s+(?:prefer|always|never|usually|favor|favourite|favorite)\b[^.!?\n]*)/i },
  { kind: "assertion", re: /\b(i\s+(?:use|am|do|have|run|work|keep|commit)\b[^.!?\n]*)/i },
  { kind: "declaration", re: /\b([A-Z][A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,3}\s+is\s+[^.!?\n]{4,})/, pick: (m) => m[1] },
  { kind: "negation", re: /\b((?:i\s+)?(?:do\s+not|don't|dont|won't|wont|will\s+not|can't|cant|cannot|never)\b[^.!?\n]*)/i },
];

// ponytail: threshold lifted verbatim from Vault write_gate.rs DUP=0.97;
// plain Set<char trigram> instead of Vault's packed-u64 machinery — that
// exists for 50k-row synchronous scans, Heimdall per-file volumes are tiny.
const DEDUP_JACCARD = 0.97;

const nfkc = (s) => s.normalize("NFKC");
const norm = (s) => nfkc(s).replace(/\s+/g, " ").trim();
export { isSecret, norm };
const factId = (body) => "fact-" + createHash("sha256").update(body).digest("hex").slice(0, 12);

// Dedup keys are lowercase + whitespace-collapsed; provenance ([path:line])
// never enters the comparison, so line shifts can't dodge or skew the gate.
const dedupKey = (utterance) => norm(utterance).toLowerCase();

function trigrams(s) {
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0; // degenerate (<3 chars): never a dupe
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function keywordsFor(kind, utterance) {
  const words = utterance.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return ["heimdall", "fact", kind, ...new Set(words)].slice(0, 8);
}

function makeFact(kind, rawUtterance, path, line) {
  const body = `${norm(rawUtterance)} [${path}:${line}]`;
  return {
    id: factId(body),
    title: norm(rawUtterance).slice(0, MAX_TITLE),
    body,
    keywords: keywordsFor(kind, rawUtterance),
    // The classification is carried on the fact itself (2026-09-28 spec K5).
    // It used to be discarded here, which is why the journal had no way to
    // answer `--kind decision`: owned_nodes.kind is the literal "fact" and
    // the id is `fact-<sha256>`, so the kind was unrecoverable downstream.
    kind,
    line,
  };
}

function extractFromLine(lineText, path, line, out, meta) {
  // Secret screen runs BEFORE pattern matching and before anything is pushed:
  // a secret-shaped line can never become a fact body (FC-09/FC-10).
  if (!lineText.trim() || isSecret(lineText)) {
    if (isSecret(lineText)) meta.skippedSecrets++;
    return;
  }
  const text = nfkc(lineText); // fold compat codepoints before matching
  for (const { kind, re, pick } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      const raw = pick ? pick(m) : (m[1] ?? m[0]);
      out.push({ fact: makeFact(kind, raw, path, line), key: dedupKey(raw) });
      return;
    }
  }
}

// Pi session logs. The real record shape is
//   {"type":"message","message":{"role":"user","content":[{"type":"text","text":...}]}}
// — the text is one level deeper than the pre-change `rec.text` this parser
// read, and because the nested shape still parses as valid JSON, the old code
// reported "no facts" rather than failing. A session log with no user text at
// all is a real, common shape (an abandoned session), so the probe reports
// what it SAW rather than whether it found anything.
const SESSION_ROLES = new Set(["user"]);

// Counts `"role"` keys outside string VALUES, so a `"role"` mentioned inside
// a text block does not count. A hand-rolled scan rather than a regex: the
// first regex attempt matched a comma inside a quoted value and was wrong on
// real inputs.
// Walks the line's JSON strings and returns true if more than one is the KEY
// `"role"`. Hand-rolled rather than a regex because a regex cannot tell a key
// from the same word inside a value, and two earlier attempts were wrong on
// real inputs: the first never fired (a dead branch after the quote toggle),
// the second mis-counted a comma inside a quoted value.
function hasDuplicateRole(line) {
  const n = line.length;
  let i = 0, count = 0;
  while (i < n) {
    if (line[i] !== '"') { i++; continue; }
    let j = i + 1;
    while (j < n) {
      if (line[j] === "\\") { j += 2; continue; }
      if (line[j] === '"') break;
      j++;
    }
    let k = j + 1;
    while (k < n && isJsonSpace(line[k])) k++;
    if (line[j] === '"' && line[k] === ":" && isRoleKey(line.slice(i, j + 1))) {
      if (++count > 1) return true;
    }
    i = j + 1;
  }
  return false;
}

// JSON whitespace between a key and its colon. Space-only was a LIVE BYPASS:
// JSON.parse accepts tab/CR/LF there, so a record with
// "role"<TAB>:"user" parsed as a duplicate role while the prescan counted
// only one, and the assistant's text became a user fact.
const isJsonSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";

// Is this quoted token the key `role`? A literal compare is not enough:
// JSON.parse decodes \\uXXXX escapes, so "\\u0072ole" IS the role key to the
// parser and last-key-wins resolved it to "user" -- measured, a live bypass of
// the prescan. Decoding the token closes it. A token that will not decode is
// not a role key.
function isRoleKey(token) {
  if (token === '"role"') return true;
  try {
    return JSON.parse(token) === "role";
  } catch {
    return false;
  }
}

// Returns null when this file is not a session log. `sawRole` is true when a
// message.role was observed, which is what makes the probe positive: a
// non-session JSONL has no role, so it falls through to parsePlain instead of
// being silently drained.
function sessionTexts(rec) {
  const m = rec?.message;
  if (m === undefined || m === null) return null;
  // A STRING message is an embedded JSON payload, not a session turn. It is
  // treated as "not a session record" so the file stays eligible for the
  // plain parser -- but the record is still marked as a session log, so
  // parsePlain cannot then re-read the raw line and lift the assistant's
  // text out of the embedded string. Without this the same text is
  // extractable purely by changing which shape the record uses.
  if (typeof m === "string") return { notSession: true, texts: [], embedded: m };
  if (typeof m !== "object" || typeof m.role !== "string") return null;
  if (!SESSION_ROLES.has(m.role)) return { notSession: true, texts: [] };
  if (typeof m.content === "string") return { notSession: false, texts: [m.content] };
  if (!Array.isArray(m.content)) return { notSession: false, texts: [] };
  return { notSession: false, texts: m.content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text) };
}

function parseJsonl(buf, path, out, meta) {
  const lines = buf.toString("utf8").split("\n");
  let sawJson = false;
  let isSession = false;
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    // A duplicated `role` key is rejected before parsing. JSON.parse is
    // last-key-wins, so `{"role":"assistant","role":"user"}` reads as
    // "user" and the assistant's text becomes a user fact -- measured. Real
    // pi logs are machine-generated so this is a hand-authored-file hazard,
    // but the "user's words only" property must hold for any input, so an
    // ambiguous record is dropped rather than guessed.
    if (hasDuplicateRole(l)) {
      // Mark the file as a session log even when the record is dropped, or
      // parsePlain() below re-reads the raw JSON and extracts the very text
      // the prescan just rejected. That was the actual bypass: the prescan
      // worked, the fallback undid it.
      sawJson = true;
      isSession = true;
      return;
    }
    try {
      const rec = JSON.parse(l);
      sawJson = true;
      // Legacy flat shape, kept for the prompt-log format. The role is
      // honoured when the record carries one: a flat {"role":"assistant",
      // "text":...} is the same assistant-origin text in a different shape,
      // and extracting it while rejecting the nested form would be an
      // inconsistency a reader could not see.
      if (typeof rec?.text === "string") {
        // Mark the file as a session log in BOTH branches, accepted or not.
        // Without this a rejected flat record falls through to parsePlain,
        // which re-reads the raw line and extracts the very text the role
        // check just refused -- the same bypass as the duplicate-key path.
        isSession = true;
        const role = typeof rec?.role === "string" ? rec.role : "user";
        if (SESSION_ROLES.has(role)) {
          rec.text.split(/(?<=[.!?])\s+|\n/).forEach((u) =>
            extractFromLine(u, path, i + 1, out, meta));
        }
        return;
      }
      const shape = sessionTexts(rec);
      if (shape === null) return; // not a session record; not our business
      isSession = true;
      shape.texts.forEach((t) => t.split(/(?<=[.!?])\s+|\n/).forEach((u) =>
        extractFromLine(u, path, i + 1, out, meta)));
    } catch { /* torn/non-JSON line: skipped by design */ }
  });
  return sawJson ? (isSession ? "session" : "json") : false;
}

function parsePlain(buf, path, out, meta) {
  const lines = buf.toString("utf8").split("\n");
  lines.forEach((l, i) => {
    l.split(/(?<=[.!?])\s+/).forEach((u) =>
      extractFromLine(u, path, i + 1, out, meta));
  });
}

/**
 * extractFacts(buf, meta) — desired state for one path, same contract shape
 * as extract.mjs desiredState: deterministic per bytes, safe to re-run.
 * @param {Buffer} buf file bytes
 * @param {{path: string}} meta source path (mutated: gains skippedSecrets,
 *   skippedDuplicates)
 * @returns {{id,title,body,keywords,line}[]}
 */
export function extractFacts(buf, meta = { path: "" }) {
  meta.skippedSecrets = meta.skippedSecrets ?? 0;
  meta.skippedDuplicates = meta.skippedDuplicates ?? 0;
  if (!buf || !buf.toString("utf8").trim()) return [];
  const out = [];
  // "session" | "json" | false. "session" means recognised session records,
  // so parsePlain must NOT run or the same text is extracted twice. The
  // pre-change code only returned a boolean, so a session log ALSO fell
  // through to parsePlain and double-extracted.
  if (parseJsonl(buf, meta.path, out, meta) !== "session" && !out.length) {
    // Only fall back when nothing was extracted: a non-session JSONL keeps
    // the plain parser, and a session log with no user text yields nothing
    // rather than being re-parsed as prose.
    parsePlain(buf, meta.path, out, meta);
  }
  // ponytail: dedup is per-path ONLY — cross-path dedup intentionally absent
  // (spec D4): fact ownership is namespaced by source file, so editing one
  // file retracts exactly its own nodes and two files stating the same fact
  // coexist with independent provenance.
  // Near-dup gate (C1 dedup half): char-trigram Jaccard vs facts already
  // accepted FOR THIS FILE; first occurrence wins. O(n²) is deliberate —
  // per-file fact counts are tiny, a shingle index would be pure ceremony.
  const keptGrams = [];
  const kept = [];
  for (const { fact, key } of out) {
    const grams = trigrams(key);
    const isDup = keptGrams.some((g) => jaccard(grams, g) >= DEDUP_JACCARD);
    if (isDup) {
      meta.skippedDuplicates++;
      continue;
    }
    keptGrams.push(grams);
    kept.push(fact);
  }
  return kept;
}
