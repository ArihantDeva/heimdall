# Vendored: graphify

`vendor/graphify/` contains a vendored copy of **graphify v0.3.17** — "turn
any folder of code, docs, papers, or images into a queryable knowledge graph"
(AI coding assistant skill for Claude Code, Codex, OpenCode, OpenClaw).

- **Upstream:** https://github.com/safishamsi/graphify (MIT License)
- **Author:** Safi Shamsi
- **License:** MIT — see `vendor/graphify/LICENSE`
- **Version vendored:** 0.3.17 (pipx graphifyy 0.3.17)
- **Vendored date:** 2026-08-20

## Why it's here

Graphify is a **default component** of Heimdall: it provides the per-repo
code-graph layer (AST + semantic extraction → graph.json → BFS/DFS query with
token budget). It complements Graft (storage) and Heimdall (agent memory
orchestration): graphify answers *codebase* questions, Graft persists
*notes/facts* across projects, Heimdall ties them together with trust verdicts.

## How to use

```python
# library API
import sys; sys.path.insert(0, "vendor")
import graphify
graphify.extract(...)          # AST + semantic extraction from repo source
graphify.build_from_json(...)  # assemble into networkx graph
graphify.cluster(...)          # community detection / cohesion
graphify.to_json / to_html / to_svg / to_wiki
```

```sh
# CLI (via python -m)
python3 -m graphify query "where does this function live"
python3 -m graphify build --graph graphify-out/graph.json
```

## Updating

To update the vendored copy: reinstall graphify (pipx), copy the new
`graphify/*.py` + LICENSE over `vendor/graphify/`, bump the version note above,
run the tests.

## Dependency note

```bash
pip install -r vendor/graphify/requirements.txt
```

Graphify requires `networkx` (>= 3.x) and `tree-sitter` for AST extraction.
Add these to your environment; Heimdall's own code does not depend on them —
they're only needed if you use the graphify component.
