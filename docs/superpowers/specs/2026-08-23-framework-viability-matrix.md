# Agent Memory Framework Viability Matrix — Heimdall Adoption Survey

Date: 2026-08-23 · Surveyor: scout subagent · Method: primary sources only (GitHub API repo metadata fetched live, READMEs/docs/arXiv abstracts via scrapling; raw copies under `/tmp/fm/docs/`). No vendor-blog numbers trusted without repo/paper backing.

Heimdall target shape (from `Repos/heimdall/AGENTS.md`, `docs/superpowers/specs/2026-08-23-fact-layer-design.md`): trust-verified self-healing KG; sqlite journal (`node:sqlite`) authoritative; graft daemon backend; **zero runtime deps**; **CPU-only, no LLM at capture** (user token promise); structural caps ≤200 LOC/file; bench baseline `bench/runs/20260823-023236/summary.json`: LongMemEval-S recall@1=0.04 @10=0.30 (facts layer not yet shipped). Any idea requiring an LLM/embedding call inside the write path is out of scope this round.

## Viability Matrix

| Framework | Stars* | Storage model | Retrieval path | Benchmark evidence | CPU-only viable? | Graph model | Decay/forgetting | Conflict resolution | Top adoptable idea for heimdall |
|---|---|---|---|---|---|---|---|---|---|
| **Letta (MemGPT)** | 24.4k | Tiered context: in-context memory blocks (strings pinned to system prompt) + out-of-context recall/archival DBs; now git-backed MemFS markdown tree | Agent-self-edited blocks always in context; archival/recall via embedding search + tools | None published for current MemFS line; historical MemGPT DMR 93.4% (Zep paper comparison point) | Server runs locally; **needs LLM API for every agent op**, embedder configurable — not capture-CPU-cheap | No KG — filesystem/blocks hierarchy | "Dreaming": background subagents consolidate lessons after N steps/compaction; `/doctor` audits drift/placement/duplication | Agent decides placement + rewrites blocks; explicit `/remember`; reorganize workflow backs up before restructuring | **Sleep-time consolidation pass**: idle-time reconciler job merging near-duplicate fact nodes + auditing memory hierarchy (maps onto existing periodic `audit()`) |
| **Zep / Graphiti** | 30.2k | Temporal context graph: episodes → entity/relation/fact edges with bi-temporal validity windows (`t_valid`/`t_invalid`) + provenance; bring-your-own graph DB (Neo4j/FalkorDB/Kuzu) | Hybrid: semantic embeddings + BM25 keyword + graph traversal, no LLM at query time | Zep paper (arXiv:2501.13956): DMR 94.8% vs MemGPT 93.4%; LongMemEval accuracy up to +18.5% vs baselines, −90% latency | **No**: ingestion requires structured-output LLM per episode (+ embedder). Query side is LLM-free — that split is the lesson | Entity nodes + relation/fact edges, prescribed (Pydantic ontology) or learned; invalidation-with-history, never delete | Explicit: changed facts get old edge invalidated (`t_invalid` set), preserved forever; query "now" vs "at time T" | Automatic fact invalidation w/ temporal history (vs LLM summarization judgment) | **Validity-window supersede**: on conflicting fact, set `valid_to` + add superseded-by edge instead of delete — fits journal generations model |
| **Mem0** | 63.9k | Extracted atomic memories in vector store + optional graph variant; history DB (SQLite default); managed platform adds proprietary optimizations | v3 (Apr 2026): single-pass ADD-only extraction; multi-signal retrieval — semantic + BM25 + entity-match scored in parallel and fused; temporal-aware ranking | Claims: LoCoMo 92.5, LongMemEval 94.4, BEAM-1M 64.1 (platform-managed stack; open-source "directionally similar"). Older paper (arXiv:2504.19413): LoCoMo judge 66.88 base / 68.44 graph | **No** for write path (LLM classifies ADD/UPDATE/DELETE); embedder swappable (HF/Ollama exist). Fusion *retrieval* itself is arithmetic — portable to CPU | Optional graph memories (entity-relation), weaker than Graphiti's temporal model | v3 moved to accumulate-nothing-overwritten (ADD-only) — decay outsourced to retrieval ranking | v2 was LLM ADD/UPDATE/DELETE ops; v3 dropped UPDATE/DELETE entirely, keeps both instances + temporal ranking picks current | **Multi-signal RRF fusion**: fuse vector + BM25 + entity-overlap lanes (~60 LOC); their LongMemEval jump 67.8→94.4 credits fusion + entity linking |
| **Cognee** | 30.2k | ECL pipeline (Extract-Cognify-Load) into self-hosted KG: default Kuzu/ladybug embedded graph + vector store (LanceDB), Postgres/Neo4j profiles; ontology grounding | Combined vector + graph search over cognified triples | Paper arXiv:2505.24478 (KG↔LLM interface reasoning); no independent LongMemEval/LoCoMo score published in repo | Partially: local graph/vector OK, Ollama supported, but **defaults OpenAI gpt-5-mini + text-embedding-3-large**; pipeline is chunky (docker profiles for prod) | Entity-relation graph from documents, ontology-prescribed classes; evolving relationships | No first-class decay found in docs | Re-cognify dedupes/merges on re-ingest; conflict handling implicit in merge | Little directly adoptable — architecture overlaps what graft already does; its "single-Postgres whole-memory-layer" pitch validates heimdall's single-backend doctrine |
| **LangMem** | 1.6k | Thin primitives over LangGraph BaseStore (namespaced docs + vector index); Postgres-backed store in prod | Two modes: hot-path memory tools (agent calls mid-chat) + background manager that extracts/consolidates async | None published (no LongMemEval/LoCoMo in repo) | **No** — LLM-driven extraction/consolidation is the entire product; embeddings configurable | No graph — flat namespaced doc store with vector index | Background manager can consolidate/rewrite; no TTL/decay primitive | "Memory consistency" delegated to LLM update prompts; no formal conflict semantics | **Hot-path vs background split**: capture cheaply inline, consolidate later — matches hint-queue + reconciler design; confirms heimdall's async posture is mainstream |
| **A-MEM** | 1.2k | Zettelkasten note network in ChromaDB: each memory a structured note (context description, keywords, tags) linked to neighbors | Embedding similarity (all-MiniLM-L6-v2) finds candidate notes → LLM judges link creation | Paper (arXiv:2502.12110, NeurIPS'25): claims superiority over SOTA baselines incl. MemGPT on six foundation models; eval repo separate (WujiangXu/A-mem) | Half: MiniLM embeddings are CPU-fine; **note generation + link/evolve decisions need LLM** per insertion | Note-to-note link graph, no typed relations, no temporal fields | Memory evolution: new notes trigger attribute/context updates of old notes — growth-biased, no forgetting | Evolution rewrites existing notes' contextual representations when new evidence arrives | **Link-at-insert**: when committing a fact node, connect to top-k cosine neighbors as pending edges — cheap with bge-m3 vectors already computed |
| **memoripy (v4)** | 0.7k | Local file store (atomic writes, checksums, transaction journal, fsync, fail-closed recovery) of bitemporal immutable-versioned records | Independent lanes (exact cue, BM25, local deterministic semantic, entity overlap, temporal, authority/trust, activation) fused via reciprocal-rank fusion; every hit returns a receipt | No public benchmark scores; ships its own JSON "memory contracts" runner (current-vs-historical truth, feedback-loop resistance, quarantine) | **Yes — the only fully CPU/local framework surveyed**: zero required third-party deps, deterministic local similarity | No KG — scoped records (user/agent/run/project/org tiers) with evidence citations | Activation/dormancy/reactivation ("brain mode"), utility-weighted not frequency-weighted; versioned forget (deletion recorded, audit trail kept) | **Admission barrier**: rejects retrieved-memory re-ingestion, assistant-authored user claims, prompt-injection content, low-confidence candidates, secrets quarantined, lower-authority contradictions rejected; `correct()` supersedes explicitly | **The whole trust doctrine mirrors heimdall** — steal concretely: (a) admission-policy checklist as pure function in `facts.mjs`, (b) audit CLI (`kb-stale-scan` extension checking unsupported/duplicate/expired/conflicting facts), (c) receipts on search hits |
| **Memobase** | 2.9k | User-profile memory: fixed schema of profile slots (topic/sub-topics) + event timeline; self-hosted server | Profile packed into prompt via `context` API; timeline search 500–1000ms; 3 fixed LLM calls per ingest run (down from 3–10) | Own eval (fork of mem0's harness): LoCoMo overall 75.78 (v0.0.37) vs Mem0 66.88, Zep 65.99, LangMem 58.10; strongest on temporal 85.05 | **No**: LLM required per ingest batch; embedding API for search | None — profile slots are a tree, events a timeline; no entity graph | Old profile values overwritten in place (profile is current-state); events keep history | Slot-level overwrite: newer observation replaces slot value; contradiction = last-write-wins per slot | **Profile-slot core projection**: derive a tiny current-state "core" view (typed slots) over fact nodes for cheap prompt injection — a render pass, not new storage |
| **MIRIX** | 3.4k | Six typed stores (Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault) in Postgres (BM25 + pgvector), multi-agent managers coordinate updates/retrieval; screen-tracking multimodal client | Meta-agent routes queries to specialist memory agents; retrieve_with_conversation API | Paper (arXiv:2507.07957): LoCoMo 85.4% claimed SOTA; ScreenshotVQA +35% over RAG baseline, −99.9% storage | **No — heaviest stack**: docker compose, Postgres, Gemini-class LLM + text-embedding-004 endpoint required | Not a graph — typed relational tables per memory kind | Knowledge Vault vs transient types imply lifetimes; no published decay algorithm | Manager agents decide which store/type absorbs an update; conflict policy opaque | **Typed memory kinds**: one enum on fact nodes (fact/preference/policy/decision/procedure/artifact) from keyword mapping — improves routing/filtering for ~20 LOC |
| **MemOS** *(2025–26 newcomer)* | 10.9k | MemCube-isolated KBs; cloud API / self-host (Neo4j+Qdrant) / **local plugin: SQLite FTS5 + vector, 100% on-device**; MemScheduler async ingestion | Hybrid FTS5+vector hybrid search; feedback-driven refinement | OmniMemEval suite: LoCoMo 88.83, LongMemEval 89.20, BEAM-10M 56.75 (self-run, harness published) | Local plugin yes (SQLite, on-device) but plugin layer wraps agent harnesses, and full product leans cloud/LLM | Cubes compose/share; internal model = traces→policies→world-models→skills tiers, not entity KG | Tiered evolution: traces crystallize into skills/policies | Natural-language feedback correct/supplement/replace operations | **Tier crystallization**: recurring fact clusters promoted to stable "skill/policy" nodes — future-round idea; also validates SQLite+FTS5+vector local stack choice |

\* Stars from GitHub API, 2026-08-23. Additional newcomers scanned: **HippoRAG 2** (3.9k★, PPR-over-OpenIE-graph; strong MuSiQue/2Wiki/MIRAGE results but needs OpenIE LLM + ColBERT encoder — not CPU-practical, schema too research-shaped), **memU** (14.3k★, markdown-wiki folder memory + scheduled skill extraction, cloud-API centric, 500-line core — its "human-readable wiki as the memory surface" is basically `~/knowledge-base/*.md` already), **supermemory** (29k★, hosted SaaS — excluded, not self-hostable), **Acontext** (3.7k★, context-data-platform sibling of Memobase — data lake angle, orthogonal).

## Per-Framework Notes

### 1. Letta (f.k.a. MemGPT) — `github.com/letta-ai/letta`
- **Architecture:** Stateful agents hold editable memory blocks in-context (pinned to system prompt); overflow lives in recall/archival stores. Current direction replaced the Python server with git-backed **MemFS** markdown memory tree (`docs.letta.com/guides/agents/memory`, `configuration/memory`).
- **Retrieval evidence:** No current benchmark claims; MemGPT's DMR 93.4% survives only as Zep's comparison baseline.
- **CPU-only:** Local server yes, but every operation is an LLM call; incompatible with capture-side token promise.
- **Graph:** None — block/file hierarchy, shared blocks across agents.
- **Decay:** "Dreaming" background consolidation after N steps or compaction; `/doctor` audits placement/duplication/token bloat; reorganize flow backs up before restructuring.
- **Conflicts:** Agent-owned edits with explicit teach (`/remember`); backup-before-reorganize.
- **Adopt:** Idle-window reconciliation pass that merges near-duplicates and prunes noise (heimdall's `audit()` already the hook point).

### 2. Zep / Graphiti — `github.com/getzep/graphiti`
- **Architecture:** Episodes (raw interactions) → entities/relations/facts as a **bi-temporal context graph**; each fact carries validity window + episode provenance; OSS engine uses pluggable graph DBs (Neo4j, FalkorDB, Kuzu), Zep platform runs proprietary engine.
- **Evidence:** arXiv:2501.13956 abstract: DMR 94.8% vs MemGPT 93.4%; LongMemEval improvements "up to 18.5%" with 90% latency reduction.
- **CPU-only:** Ingestion needs a structured-output LLM per episode plus embedder; retrieval is deliberately LLM-free (hybrid semantic+BM25+traversal). The ingest/query asymmetry is itself adoptable.
- **Graph:** Entity nodes, relation/fact edges; Pydantic-prescribed or learned ontology; **invalidate-don't-delete** with full temporal history; "what was true at T" queries.
- **Decay:** None needed internally — invalidation windows replace decay.
- **Conflicts:** New contradicting fact sets old edge's `t_invalid`; both persist.
- **Adopt:** `valid_from`/`valid_to` + superseded-by edges on fact nodes in the journal; conflicts become co-existence with windows, exactly the spec's deferred non-goal, unlocked cheaply because journal generations already order writes.

### 3. Mem0 — `github.com/mem0ai/mem0`
- **Architecture:** Conversation → extracted atomic memories in vector store (+optional graph variant); v2 did LLM-judged ADD/UPDATE/DELETE; **v3 (Apr 2026) went single-pass ADD-only** with entity linking and multi-signal fused retrieval.
- **Evidence:** README benchmark table: LoCoMo 71.4→92.5, LongMemEval 67.8→94.4, BEAM-1M 64.1 — explicitly caveated as managed-platform numbers; evaluation harness open-sourced (`mem0ai/memory-benchmarks`). Original paper: LoCoMo judge 66.88/68.44(graph).
- **CPU-only:** Write path needs LLM (even if only one call); embedder swappable (OpenAI default, HF/Ollama available). Retrieval fusion is plain arithmetic — the portable part.
- **Graph:** Optional entity-relation memories; less rigorous than Graphiti temporally.
- **Decay:** None — accumulation + ranking does the work (ADD-only philosophy).
- **Conflicts:** v3 sidesteps them: nothing overwritten; temporal ranking surfaces the right dated instance for "current"/"past"/"future" phrasings.
- **Adopt:** Three-lane retrieval (graft vector + lexical/BM25 + entity-overlap) fused by RRF in `kb-search.sh`; second adopt: entity-linking boost (inverted entity index over fact keywords).

### 4. Cognee — `github.com/topoteretes/cognee`
- **Architecture:** ECL pipelines cognify documents into a self-hosted KG (default embedded Kuzu/ladybug + LanceDB; Postgres-all-in-one demo; Neo4j/PGVector profiles) combining vector + graph reasoning with ontology grounding.
- **Evidence:** Methodology paper arXiv:2505.24478; no independent LoCoMo/LongMemEval number published in-repo — weakest evidence-to-star ratio of the big repos.
- **CPU-only:** Defaults OpenAI gpt-5-mini + text-embedding-3-large (docs.cognee.ai installation); Ollama possible; production posture wants docker profiles.
- **Graph:** Document-derived entity-relation triples with ontology classes.
- **Decay:** None documented.
- **Conflicts:** Implicit re-ingest dedupe/merge.
- **Adopt:** Nothing concrete — it is a heavier sibling of graft. Its marketing pivot ("whole memory layer on one Postgres") confirms the single-backend thesis heimdall already embodies.

### 5. LangMem — `github.com/langchain-ai/langmem`
- **Architecture:** SDK of memory primitives over LangGraph BaseStore: hot-path tools (`create_manage_memory_tool`, `create_search_memory_tool`) plus a background manager that extracts/consolidates asynchronously; namespaces + vector index (1536-dim OpenAI default, Postgres store in prod).
- **Evidence:** None published.
- **CPU-only:** No — LLM calls define the feature set; embeddings configurable.
- **Graph:** None — namespaced docs.
- **Decay:** Consolidation can rewrite; no decay/TTL primitive.
- **Conflicts:** Delegated to LLM update prompts ("maintains memory consistency"); no formal semantics.
- **Adopt:** Validates hot-path/background split; otherwise skip — heimdall's hint queue ≙ its background manager with better consistency guarantees.

### 6. A-MEM — `github.com/agiresearch/A-mem`
- **Architecture:** Zettelkasten memory network in ChromaDB: each memory becomes a structured note (contextual description, keywords, tags); insertion analyzes historical notes and links meaningful neighbors; new memories can **evolve** prior notes' attributes (arXiv:2502.12110, NeurIPS 2025).
- **Evidence:** Paper claims consistent superiority over SOTA baselines (incl. MemGPT) across six foundation models; exact tables live in companion eval repo.
- **CPU-only:** Embeddings are all-MiniLM-L6-v2 (CPU fine) but note-generation and link/evolution decisions require an LLM at write time.
- **Graph:** Untyped note-to-note link network; no temporal fields, no edge semantics.
- **Decay:** None — evolution is additive/refining.
- **Conflicts:** Handled by rewriting old notes' contextual representations (mutating history — anti-pattern vs heimdall immutability).
- **Adopt:** Link-at-insert only: on fact commit, emit pending edges to top-k cosine neighbors among same-project facts; graft pending-edge machinery exists.

### 7. memoripy v4 — `github.com/caspianmoon/memoripy` (693★; v4 branch is the live line)
- **Architecture:** Evidence-first local runtime: bitemporal, immutable-versioned records with evidence spans in a fail-closed file store (atomic writes, fsync, checksums, transaction journal, explicit recovery); recall fuses independent lanes via RRF and attaches receipts explaining why each result was selected.
- **Evidence:** No external benchmarks; ships executable "memory contracts" (current-vs-historical truth, re-ingestion resistance, instruction-quarantine, multi-user isolation, Unicode) — a self-audit stance rather than leaderboard chasing.
- **CPU-only:** **Fully** — zero required third-party deps; deterministic local semantic similarity by default; optional embedding/pgvector extras.
- **Graph:** None — scope-tiered records (user/agent/run/project/org/namespace), adaptive expansion outward only on insufficient coverage.
- **Decay:** Attention model with dormancy/reactivation/working memory; utility signals (confirmed use, outcomes, corrections) separated from raw retrieval frequency so popularity doesn't masquerade as importance.
- **Conflicts:** Formal admission barrier pre-write: reject retrieved-memory re-ingestion, assistant-authored user claims, system-prompt restatements, transient acknowledgements, untrusted-content instructions (quarantined not stored as preference), secrets quarantined, lower-authority contradictions; explicit `correct()` supersedes; `forget()` is versioned deletion preserving audit trail.
- **Adopt:** Closest philosophical match to heimdall in the survey. Concretely: (a) encode the admission-barrier checklist as pure-function filters inside `facts.mjs` (fits D2/D5, ≤200 LOC cap); (b) extend `kb-stale-scan.py` into a memoripy-style audit (unsupported facts missing evidence, duplicates, expired-active, conflicting-current, citation gaps); (c) receipts on `kb_search` hits — verdict + lanes + why-included.

### 8. Memobase — `github.com/memodb-io/memobase`
- **Architecture:** Profile-as-memory: LLM distills conversations into a fixed slot schema (basic_info/education/work/…, extensible via config) plus event timeline; `context` API renders profile+events straight into a prompt; fixed 3 LLM calls per ingest run.
- **Evidence:** Self-run LoCoMo fork (of mem0's evaluator): Memobase v0.0.37 overall 75.78 vs Mem0 66.88 / Zep 65.99 / LangMem 58.10; standout temporal 85.05 (event timeline is the differentiator).
- **CPU-only:** No — server + LLM + embedding API; but per-run LLM cost is bounded (3 calls) which is the honest-budget design.
- **Graph:** No entity graph; slot tree + chronology.
- **Decay:** Slots overwrite to stay current-state; events preserve history.
- **Conflicts:** Last-write-wins per slot — simple, predictable, lossy.
- **Adopt:** Core-projection render: derive a compact current-state view (top slots per type with winning fact + provenance pointer) from fact nodes; consumed by `extensions/kb-orient.ts` style prompt injection.

### 9. MIRIX — `github.com/Mirix-AI/MIRIX`
- **Architecture:** Six specialized memory components (Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault) in Postgres with BM25+pgvector; a meta-agent coordinates specialist agents that manage updates and answer routed retrievals; flagship client watches your screen (multimodal).
- **Evidence:** arXiv:2507.07957: LoCoMo 85.4% claimed SOTA; ScreenshotVQA +35% over RAG, storage −99.9%.
- **CPU-only:** Worst-in-class footprint: docker compose stack, Postgres, Gemini-class LLM + text-embedding-004 endpoints.
- **Graph:** None — typed relational tables.
- **Decay:** Implicit via vault-vs-transient typing; no published mechanism.
- **Conflicts:** Manager-agent discretion; opaque.
- **Adopt:** Only the taxonomy: stamp fact nodes with a `kind` enum (fact/preference/policy/decision/procedure/artifact) via keyword rules in `extractFacts`; enables kind-filtered retrieval for trivial cost.

### 10. MemOS — `github.com/MemTensor/MemOS` (newcomer)
- **Architecture:** Memory operating system with composable MemCube KBs; deployment ladder from cloud API → self-host (Neo4j+Qdrant) → **100%-local plugin: persistent SQLite, FTS5+vector hybrid, task summarization, skill evolution**; MemScheduler async ingests.
- **Evidence:** OmniMemEval harness (published): LoCoMo 88.83, LongMemEval 89.20, BEAM-10M 56.75; agent-task completion 36.63%→50.87% with memory attached.
- **CPU-only:** Local plugin genuinely on-device; the wider system assumes LLM services.
- **Graph:** Cube composition/sharing; internal tiers L1 traces → L2 policies → L3 world models → crystallized skills rather than entity-relation graphs.
- **Decay:** Tiered evolution moves value upward (trace→skill); stale traces age out implicitly.
- **Conflicts:** Natural-language feedback ops (correct/supplement/replace) refine memories.
- **Adopt:** Crystallization idea for a later round: fact clusters confirmed useful ≥N times promote into a "policy/skill" node surfaced preferentially; also independent confirmation of SQLite+FTS5+vector as the credible local stack.

### Also-rans (checked, deprioritized)
- **HippoRAG 2** (OSU-NLP-Group, ICML'25): Personalized-PageRank over LLM-OpenIE graphs; excellent associative benchmarks (MuSiQue/2Wiki/HotpotQA/NarrativeQA) but requires extraction LLM + ColBERT encoder and binds indexes to model identity — wrong shape for a CPU, zero-dep daemon.
- **memU** (14.3k★): Memory-as-markdown-wiki distilled by scheduled background task; cloud-API-centric despite "500-line core". Its surface (readable md files) is what `~/knowledge-base/*.tsv/md` already provides.
- **supermemory** (29k★): Hosted SaaS; not adoptable into a self-hosted trust boundary.

## Ranked Adoptable Ideas — impact-per-LOC for heimdall

1. **Multi-lane RRF retrieval fusion** (Mem0 v3 + memoripy lanes) — fuse graft vector lane + lexical lane + entity-overlap lane, ~60 LOC in `bin/kb-search.sh`/`kb_search_verify.py`. Direct attack on the measured recall floor (@1=0.04). Highest lift per line.
2. **Fact admission barrier** (memoripy v4) — ~40 LOC of pure-function reject rules in `facts.mjs`: re-ingested memory, assistant-authored user claims, prompt-injection patterns, secret regex (already D5), transient acks. Protects trust labels from garbage at the only entry point.
3. **Temporal validity windows** (Graphiti) — `valid_from`/`valid_to` + superseded-by edges on fact nodes; conflicts become co-existence-with-windows. Journal generations already supply ordering; unlocks the temporal question class (weakest LongMemEval category) without deletion.
4. **Entity-overlap boosting** (Mem0 v3) — invert fact keywords/entities; boost hits sharing query entities. ~25 LOC pure JS.
5. **Typed memory kinds** (MIRIX taxonomy) — enum column + keyword mapping in `extractFacts`; enables kind-scoped retrieval and cleaner core rendering. ~20 LOC.
6. **Search receipts** (memoripy) — extend verdict payload with lanes matched + why-included; strengthens the STRONG/WEAK/STALE contract the harness rules depend on. Mostly formatting.
7. **Audit sweep extension** (memoripy audit) — grow `kb-stale-scan.py`: unsupported facts (no source span), duplicates, expired-active, conflicting-current. Reuses existing sweep plumbing.
8. **Core projection render** (Memobase slots) — derived current-state view over facts for prompt injection; a renderer, zero new storage. Do after kinds (#5) exist.
9. **Idle consolidation pass** (Letta dreaming) — reconciler idle job merging near-duplicates (cosine ≥0.95 same path) with backup; guard with existing convergence/idempotency tests.
10. **Link-at-insert** (A-MEM) — pending edges to top-k neighbors at commit; graft supports pending edges, but benefit unproven until #1 lands.
11. **Crystallization tiers** (MemOS) — defer; needs usage telemetry accumulated first.
12. **Framework adoption wholesale** — rejected for all ten: every one either needs an LLM in the write path, a second datastore, or breaks zero-runtime-deps. Ideas only; the journal-authoritative architecture stays.

## Risks / Open Questions
- All headline benchmark numbers (Mem0 94.4, MemOS 89.20, MIRIX 85.4, Memobase 75.78) are self-reported on self-run harnesses with differing judges/models; cross-comparability is weak. Directional conclusions only.
- RRF fusion lift for heimdall is unproven until run against the identical 50-question bench subset (spec goal #3 ablation protocol covers this).
- Validity windows interact with exact-retraction-on-file-delete (spec D4): deleting a source must retract owned facts regardless of window — needs an explicit rule before implementing #3.
- memoripy v4 is a young branch (693★ repo) — mine ideas/code patterns, do not vendor.
