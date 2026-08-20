# Vendored: Graft

`vendor/graft/` contains a vendored copy of **Graft** — a local-first semantic
memory daemon (SQLite + local embeddings + graph edges) that powers Heimdall's
storage + hybrid ranked retrieval.

- **Upstream:** https://github.com/tinygrad/graft (Apache 2.0)
- **License:** Apache 2.0 — see `vendor/graft/LICENSE`
- **Vendored date:** 2026-08-20
- **Contents:** source (`src/`), headers (`include/`), CMake build, config
  example, README, CHANGELOG, LICENSE, VERSION

## What's vendored (and what's not)

Vendored: the **source codebase** (`src/` — 49 files, ~524K) + `include/` +
build files. This is the actual code — daemon, CLI, storage, embed, retrieve,
explore, verify, http.

**Not vendored** (keeps the repo small):
- `build/` — compiled artifacts (graft/graftd binaries). Build from source.
- `third_party/` — vendored upstream deps (llama.cpp ~185M, sqlite-vec,
  BLAKE3, mpack) with their own licenses. CMake fetches/expects these at
  build time; they are NOT Graft's code.

## Why it's here

Graft is the **default backend** of Heimdall: it provides the storage +
ranking engine (hybrid lexical/vector retrieval, graph edges, keyword dedup,
local bge-m3 embeddings, verified semantic cache). Heimdall orchestrates it —
watching sessions, keeping the graph fresh, verifying hits. Vendoring the
source makes the full stack reproducible and auditable.

## Building

```bash
cd vendor/graft
# third_party deps (llama.cpp, sqlite-vec, BLAKE3, mpack) are fetched by
# scripts or expected in third_party/ — see upstream README for exact steps.
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target graft graftd
# produces build/graft + build/graftd — put them on $PATH
```

Then point Heimdall at it: `graft` on `$PATH`, config at `~/.graft/config.yaml`
(see `config.example.yaml`).

## Updating

Re-sync from upstream: copy the new `src/`, `include/`, `CMakeLists.txt`,
`LICENSE`, `README.md`, `config.example.yaml`, `VERSION` over
`vendor/graft/`, bump the date above, rebuild + test.

## License note

Graft is Apache 2.0. Its `third_party/` deps (llama.cpp MIT, sqlite-vec
Apache/MIT, BLAKE3 CC0/Apache, mpack MIT) are NOT vendored here — see the
upstream repo for their licenses when building.
