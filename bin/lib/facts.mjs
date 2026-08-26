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

export const containsSecret = (s) => SECRET_RES.some((re) => re.test(s));

// Ordered fact patterns over one normalized utterance. First match wins kind,
// so the order below IS the precedence: preferences outrank generic
// assertions, declarations outrank bare negations.
// ponytail: English-only patterns — deliberate recall ceiling per spec
// ("non-English: no match → zero facts, acceptable"); upgrade path is extra
// pattern packs behind this same table, never a second extractor.
const PATTERNS = [
  { kind: "preference", re: /\b(i\s+(?:prefer|always|never|usually|favor|favourite|favorite)\b[^.!?\n]*)/i },
  { kind: "assertion", re: /\b(i\s+(?:use|am|do|have|run|work|keep|commit)\b[^.!?\n]*)/i },
  { kind: "declaration", re: /\b([A-Z][A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,3})\s+is\s+([^.!?\n]{4,})/ },
  { kind: "negation", re: /\b((?:i\s+)?(?:do\s+not|don't|dont|won't|wont|will\s+not|can't|cant|cannot|never)\b[^.!?\n]*)/i },
];

const nfkc = (s) => s.normalize("NFKC");
const norm = (s) => nfkc(s).replace(/\s+/g, " ").trim();
const factId = (body) => "fact-" + createHash("sha256").update(body).digest("hex").slice(0, 12);

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
    line,
  };
}

function extractFromLine(lineText, path, line, out, meta) {
  // Secret screen runs BEFORE pattern matching and before anything is pushed:
  // a secret-shaped line can never become a fact body (FC-09/FC-10).
  if (!lineText.trim() || containsSecret(lineText)) {
    if (containsSecret(lineText)) meta.skippedSecrets++;
    return;
  }
  const text = nfkc(lineText); // fold compat codepoints before matching
  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      out.push(makeFact(kind, m[1] ?? m[0], path, line));
      return;
    }
  }
}

function parseJsonl(buf, path, out, meta) {
  const lines = buf.toString("utf8").split("\n");
  let sawJson = false;
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const rec = JSON.parse(l);
      sawJson = true;
      const text = typeof rec?.text === "string" ? rec.text : "";
      text.split(/(?<=[.!?])\s+|\n/).forEach((u) =>
        extractFromLine(u, path, i + 1, out, meta));
    } catch { /* torn/non-JSON line: skipped by design */ }
  });
  return sawJson;
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
 * @param {{path: string}} meta source path (mutated: gains skippedSecrets)
 * @returns {{id,title,body,keywords,line}[]}
 */
export function extractFacts(buf, meta = { path: "" }) {
  meta.skippedSecrets = meta.skippedSecrets ?? 0;
  if (!buf || !buf.toString("utf8").trim()) return [];
  const out = [];
  if (!parseJsonl(buf, meta.path, out, meta)) parsePlain(buf, meta.path, out, meta);
  // ponytail: dedup is per-path ONLY — cross-path dedup intentionally absent
  // (spec D4): fact ownership is namespaced by source file, so editing one
  // file retracts exactly its own nodes and two files stating the same fact
  // coexist with independent provenance.
  const seen = new Set();
  return out.filter((f) => (seen.has(f.title) ? false : (seen.add(f.title), true)));
}
