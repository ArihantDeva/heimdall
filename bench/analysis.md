# LongMemEval 95% — Root-Cause Analysis (2026-08-23)

Target: heimdall ≥95% on LongMemEval-S and LongMemEval-M, CPU-only
(no LLM/embedding call at ingest; tokens only at read/judge).

Baseline (committed runs, `--subset cycle1`: 20 single-session-user + 10 multi-session):

| type | @1 | @5 | @10 | @25 |
|---|---|---|---|---|
| single-session-user | 0.20 | 0.25 | 0.30 | 0.80 |
| multi-session | 0.30 | 0.50 | 0.60 | 0.90 |

## Two confirmed failure mechanisms (code-level)

### 1. FTS query AND-joins every question token → gold session rarely matches

`vendor/graft/src/storage/storage.c`, `build_scoped_fts_query`:

- Tokens are joined with a plain space, e.g. `title:"what" title:"degree" title:"did" title:"I" title:"graduate" title:"with"`.
- In FTS5, unquoted tokens separated by whitespace in a MATCH expression are an **AND** (implicit intersection): a row must contain ALL of them.
- LongMemEval questions are natural-language sentences. The gold session contains the content words ("degree", "graduate") but not the stopwords ("what", "did", "with"). The AND query therefore matches ~nothing, and retrieval falls back to the vector lane.
- The vector lane embeds only the **title** (`insert.c:313` `mg_embed_text(ctx->embed, title, q)`), and bench session titles are `session <hash> — <date>` — content-free. So the vector lane is junk for content queries.
- Result: RRF of [vector-on-title (junk), BM25-title-AND (empty), BM25-body-AND (empty)] → near-random ranking, recall@1=0.2.

### 2. Vector lane embeds the title, not the body

`vendor/graft/src/insert/insert.c:313`:

```c
mg_embedding_t q;
err = mg_embed_text(ctx->embed, title, q);
```

Only the node title is embedded and stored in `node_vec`. The bench inserts the full session markdown as body, with title = `session <id> — <date>`. So `mg_storage_vector_topk` scans vectors that encode a session id + date string — semantically useless for "What degree did I graduate with?".

## The retrieval ceiling (pure-Python BM25/OR simulator over real data)

Simulated proper BM25 over full session bodies (idf-weighted, single-term OR semantics) on the exact cycle1 subset:

| type | @1 | @5 | @10 | @25 |
|---|---|---|---|---|
| single-session-user | 0.90 | 0.95 | 1.00 | 1.00 |
| multi-session | 0.70 | 0.90 | 0.90 | 0.90 |

- The data is retrievable. Proper lexical retrieval alone clears every current cell and hits the target at @25 (single) and nearly (multi).
- The only questions that fail recall at any k under pure BM25:
  - single-session @1 misses (rank 2-3, not 1): `118b2229` (commute), `5d3d2817` (occupation), `ad7109d1` (internet speed)
  - multi-session `6d550036` ("how many projects") — gold sessions rank [6,8,11,39]: @1/@5/@10 miss, @25 hit
  - multi-session `gpt4_f2262a51` ("how many different doctors") — gold ranks [43,47,48]: **fails all k** — the question terms "doctors/visit/different" have near-zero lexical overlap with gold sessions; the real signal is "Dr. Patel / ENT specialist / dermatologist / primary care physician", none of which share tokens with the question. Lexical-hard by construction; needs the fact layer + query expansion.

## Fix stack (CPU-only)

1. **FTS OR-join** — change `build_scoped_fts_query` to OR-join tokens (BM25 scores partial matches). This is the single biggest lever: it turns the body-BM25 lane into a real ranker.
2. **Vector lane: embed title+body** — `insert.c` embed `title + "\n" + body` instead of title alone, so the semantic lane encodes content. (Bench deletes per-question, so fresh inserts pick up new embeddings.)
3. **Fact layer + query expansion** (already partially built, cycle-2 eval) — for lexical-hard questions, CPU-extracted fact nodes carry content keywords and a `sid:<parent title>` link; retrieval rewrites fact hits to parent sessions. Expect +0.4 on multi-session (measured in cycle-2).
4. **Scored run** — reader/judge (`claude` CLI) on retrieved contexts. Only token spend.

## Constraints honored

- No LLM, no embedding call at ingest. Extraction = regex/heuristic (`bin/lib/facts.mjs`), retrieval = graft (BM25 + local BGE-M3 embedding, CPU).
- Bench uses the isolated `longmemeval` graft profile only; `default` profile never touched.
- M dataset fetch is the consciously-lifted disk-budget gate (bench/README.md).
