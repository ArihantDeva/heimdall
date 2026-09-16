// bench/improvement/retrieval-case.mjs — documents and queries for the REAL
// retrieval lane.
//
// Labels are frozen BEFORE any measurement: `gold` names the document that must
// be found for each query, chosen from the document text, not from what a run
// returned. Editing a label moves `hash`, which the gate reports as a changed
// corpus rather than as an improvement (that was a review finding: labels were
// previously unhashed, so reordering a fixture moved the metrics silently).
//
// Design notes:
//   · documents are short and topically disjoint, so a correct semantic index
//     separates them cleanly and a broken one cannot pass by accident
//   · two queries are deliberately lexical near-misses (both mention "guard")
//     so the lane can distinguish real ranking from keyword luck
//   · one query has no matching document, to keep the "must not promote" case
import { createHash } from "node:crypto";

// NOTE on filenames: insert_card() embeds `relative-path + body`, so a
// descriptive filename leaks the answer into the vector and a query can match
// on the name alone. Discovered while writing the validity test: scrambling
// every document body left recall@1 unchanged at 0.889, because the ranking was
// riding on the filenames. Neutral names keep the ONLY signal in the content,
// which is what this lane claims to measure.
const DOCS = [
  {
    name: "doc-01.md",
    text: "The reconciler daemon is the only writer of the knowledge graph. It takes an exclusive lock file before converging, and reclamation only happens when the recorded process is provably gone.",
  },
  {
    name: "doc-02.md",
    text: "The search guard warns only on unscoped discovery chains. Explicit paths, reads of known files, and repository-scoped searches never trigger enforcement, and a pause switch suspends it temporarily.",
  },
  {
    name: "doc-03.md",
    text: "A search hit is labelled STRONG only when the file still exists and its content corroborates the query. Content mismatch downgrades the verdict even when the path is live.",
  },
  {
    name: "doc-04.md",
    text: "Embeddings come from a small CPU model chosen for throughput. A larger multilingual model was measured as far slower and was rejected for the indexing budget.",
  },
  {
    name: "doc-05.md",
    text: "The capability probe spawns a python interpreter and runs the real extraction bridge over a real file, then requires symbol nodes back rather than trusting an import to succeed.",
  },
  {
    name: "doc-06.md",
    text: "Reconciliation is level-triggered: read the disk, compute desired state, and converge the graph toward it, rather than reacting to individual events.",
  },
  {
    name: "doc-07.md",
    text: "A second hook implementation graded the same agent action differently from the extension because their tool name sets and escalation thresholds diverged.",
  },
  {
    name: "doc-08.md",
    text: "A frozen baseline makes regressions visible. Before freezing, the measurement must be shown repeatable, and a baseline recorded under load is worthless.",
  },
];

// Gold labels are document names, frozen here from the document TEXT above —
// never from what a run happened to return.
const QUERIES = [
  { id: "single-writer", text: "which component is allowed to write the graph", gold: ["doc-01.md"] },
  { id: "guard-scoping", text: "when does the guard warn during discovery", gold: ["doc-02.md"] },
  { id: "verdict-content", text: "what makes a hit trustworthy enough to report strong", gold: ["doc-03.md"] },
  { id: "model-choice", text: "why was the embedding model kept small", gold: ["doc-04.md"] },
  { id: "probe", text: "how does the capability probe decide what a machine can extract", gold: ["doc-05.md"] },
  { id: "convergence", text: "what style of reconciliation keeps the graph matching the disk", gold: ["doc-06.md"] },
  { id: "duplication-near-miss", text: "a second guard implementation behaved inconsistently", gold: ["doc-07.md"] },
  { id: "baseline", text: "what must be true before a baseline is recorded", gold: ["doc-08.md"] },
  { id: "unanswerable-must-not-promote", text: "quarterly revenue recognition policy for aircraft leasing", gold: ["__no_such_document__"] },
];

export const RETRIEVAL_CASE = {
  docs: DOCS,
  queries: QUERIES,
  hash: hashCase(DOCS, QUERIES),
};

export function hashCase(docs = DOCS, queries = QUERIES) {
  const canonical = [
    ...docs.map((d) => `${d.name}|${d.text}`),
    ...queries.map((q) => `${q.id}|${q.text}|${q.gold.join(",")}`),
  ].join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** Integrity: no duplicate document names, no query without gold, no empty set. */
export function validateCase(docs = DOCS, queries = QUERIES) {
  const problems = [];
  if (!docs.length) problems.push("no documents");
  if (!queries.length) problems.push("no queries");
  const names = new Set();
  for (const d of docs) {
    if (names.has(d.name)) problems.push(`duplicate document name: ${d.name}`);
    names.add(d.name);
  }
  for (const q of queries) {
    if (!q.gold.length) problems.push(`${q.id}: no gold`);
  }
  return problems;
}
