# Heimdall

**Your agent keeps rebuilding work you already did. Heimdall makes it stop.**

Every AI coding session starts cold. Grep across your repos can't answer *"did
I already solve this in another project?"* — the answer lives in a different
directory, described in prose, under a path you've never opened. The result:
**the same work rebuilt three times.**

Heimdall is a self-healing, **trust-verified knowledge layer** for AI coding
agents. It watches what your agent does, keeps a semantic memory graph fresh
across every project you touch, and — the part nobody else builds — **labels
every search hit with a trust verdict** so your agent never acts on a dead
path or a hallucinated match.

## The trust verdict (the differentiator)

Every search result is verified against reality before your agent sees it:

- `STRONG` — path exists on disk, strong lexical coverage, **and** the file's
  actual content answers the query (content-aware scoring)
- `WEAK` — semantic match only; plausible but unverified
- `REBUILT` — file moved; Heimdall found it and re-anchored automatically
- `STALE` / `REMOVED` — dead path, logged and pruned so it stops ranking

An agent acting on a dead path is worse than no answer. Verdicts are what make
the graph trustworthy enough to act on.

## Quickstart

```bash
npm i -g heimdall

# one-time: install the graft backend (local semantic-memory daemon)
#   see https://github.com/tinygrad/graft — put the `graft` binary on PATH
#   (e.g. ~/.local/bin/graft) and create ~/.graft/config.yaml:
#   cp "$(npm root -g)/heimdall/config/heimdall.yaml.example" ~/.graft/config.yaml

# wire it into your harness (pi | claude-code | codex | cursor | windsurf | all)
heimdall init --harness claude-code

# verify the backend is healthy
heimdall doctor

# search across every project you've worked in
heimdall search "excel tracker portfolio optimization"

# record reusable work when your agent finishes something
heimdall insert --title "poker jam_opt optimizer" \
  --body "~/Repos/poker-bot/tools — heads-up jam/fold EV optimizer" \
  --keywords poker,optimize
```

`init`, `insert` and the harness wiring work immediately; `search` and
`doctor` need the graft backend installed separately (build from source —
embedding model download included, so not instant). The vendored `vendor/graft/`
is source + attribution, not a prebuilt binary.

## Works with your harness

| Harness | Command | Integration |
|---|---|---|
| **Pi** | `heimdall init --harness pi` | native extensions: `kb_search`/`kb_insert`/`kb_sync` tools, edit autosync, session orientation |
| **Claude Code** | `heimdall init --harness claude-code` | PostToolUse hook syncs edits live + memory snippet |
| **Codex CLI** | `heimdall init --harness codex` | `AGENTS.md` search/insert instructions |
| **Cursor** | `heimdall init --harness cursor` | rules file with search-first workflow |
| **Windsurf** | `heimdall init --harness windsurf` | rules file with search-first workflow |

See [docs/adapters.md](docs/adapters.md) for what each adapter installs.

## What it does

| Component | File | Job |
|---|---|---|
| **CLI** | `bin/heimdall.js` | `init` / `search` / `insert` / `doctor` |
| **Ranked search** | `bin/kb-search.sh` | top-k ranked candidates + graph walk, `--scope` filter |
| **Trust verification** | `bin/kb_search_verify.py` | content-aware `STRONG`/`WEAK`/`STALE`/`REBUILT` verdicts |
| **Edit-log sync** | `bin/sync-edits.sh` | refresh the graph from agent session edit logs |
| **Self-healing graph** | `extensions/kb-autosync.ts` | edits, moves, deletes, renames update the graph live |
| **Search guard** | `extensions/kb-search-guard.ts` | warns the agent after 3 grep-style searches without consulting memory |
| **Session orientation** | `extensions/kb-orient.ts` | injects relevant prior work into the first prompt of a session |
| **Health & telemetry** | `bin/kb-health.sh`, `bin/telemetry.sh` | daemon health, index freshness, usage stats |
| **Stale pruning** | `bin/kb-stale-scan.py`, `bin/kb-rehome.sh` | dead anchors get rehomed or removed |
| **Backend** | `vendor/graft/` | Graft (Apache 2.0) — local-first semantic memory daemon |

## Architecture

```
agent harness (Pi / Claude Code / Codex / Cursor / Windsurf)
        │  hooks + tools
        ▼
Heimdall orchestration ── trust verification ── self-healing sync
        │ thin CLI contract (insert/retrieve/explore/get/delete/stats)
        ▼
semantic memory backend (Graft, vendored)
```

**Backends are pluggable.** Any store speaking the CLI contract works; Graft is
the vendored reference.

## Requirements

- Node ≥ 20, `bash`, `python3`
- macOS today (launchd daemon management); Linux works with a manual daemon

## Testing

```bash
npm test          # 22 tests: CLI, init idempotency, adapters, trust verdicts, guard
npx tsc --noEmit  # typecheck
```

## License

MIT. Independent project — not affiliated with Graft or its authors.

### Attribution

- **[Graft](https://github.com/tinygrad/graft)** (Apache 2.0) — vendored as the
  default semantic-memory backend (`vendor/graft/`).
- **[Graphify](https://github.com/safishamsi/graphify)** (MIT, © Safi Shamsi) —
  vendored per-repo AST+semantic code graph (`vendor/graphify/`).
