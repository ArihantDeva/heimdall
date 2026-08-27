# Heimdall setup — hardware-fitted configuration

`heimdall setup` detects your hardware, generates `~/.graft/config.yaml` for
the graft C++ daemon, downloads an embedding model if needed, and
installs/repairs the launchd daemon. Then `heimdall doctor` verifies it all.

```
heimdall setup [--model <catalog-id>] [--model-path /path/to/model.gguf]
               [--threads N] [--instances N] [--accel auto|metal|cuda|cpu]
               [--graftd /path/to/graftd] [--skip-daemon] [--detect-only]
```

## Flow

1. **Detect** — platform, physical cores, accelerator (see matrix below).
   `--detect-only` prints the profile and writes nothing.
2. **Model** — resolved in this order: `--model-path` (validated: exists,
   `.gguf`, ≥10MB) → vendored `vendor/graft/models/<id>.gguf` →
   `~/.graft/models/<id>.gguf` → download from the catalog (size-verified,
   atomic rename, idempotent skip when already present).
3. **Config** — renders `~/.graft/config.yaml` (annotated, mirrors
   `vendor/graft/config.example.yaml` schema). An existing file is backed up
   to `config.yaml.bak-<timestamp>` first — never clobbered.
4. **Daemon** — graftd binary from `--graftd`, else the freshly built
   `vendor/graft/build/graftd`, else the existing `~/.local/bin/graftd`;
   copied to `~/.local/bin/graftd`, plist written to
   `~/Library/LaunchAgents/com.graft.daemon.plist`, loaded via
   `launchctl bootout` → `bootstrap` (waits for unload; retries bootstrap).
   `--skip-daemon` prints the manual start command instead.
5. **Verify** — `heimdall doctor` checks: config present, `graftd
   --check-config` passes, model file present + ≥10MB, plist valid, daemon
   running.

## Hardware matrix (auto-detected defaults)

| Platform | Accel | Threads | Instances | Notes |
|---|---|---|---|---|
| Apple Silicon (darwin + `hw.optional.arm64=1`) | `metal` | physical cores | 2 if ≥8 cores else 1 | llama.cpp Metal backend |
| Intel mac | `cpu` | physical cores | 1 | no discrete-GPU detection |
| Linux + `nvidia-smi` | `cuda` | physical cores | 2 if ≥8 cores else 1 | requires llama.cpp built with `-DGGML_CUDA=ON` |
| Linux, no NVIDIA | `cpu` | physical cores | 1 | |

Flag overrides: `--threads`, `--instances`, `--accel auto|metal|cuda|cpu`.
`hardware_accel: true` is written for `metal`/`cuda`; it must match the
llama.cpp build backend (the vendored build enables Metal on Apple Silicon).

## Model catalog

| id | dims | ctx | size | notes |
|---|---|---|---|---|
| `bge-m3` (default) | 1024 | 8192 | ~587MB | multilingual, reference choice |
| `bge-small-en-v1.5` | 384 | 512 | ~36MB | tiny english, low RAM |
| `snowflake-arctic-embed-s` | 384 | 512 | ~34MB | tiny, strong english retrieval |
| `nomic-embed-text-v1.5` | 768 | 2048 | ~86MB | mid-size, longer context |

**Swapping models invalidates existing embeddings** — vectors from different
models are not comparable. `heimdall setup` prints this warning when a model
is selected; re-index or rebuild affected graft profiles afterwards
(`bin/kb-rebuild.sh` is the last-resort full rebuild). Per-repo lexical graphs
are unaffected.

BYO model: `heimdall setup --model-path /path/to/your.gguf --skip-daemon`.

## Config resolution chain (graftd)

The vendored graft daemon (fork delta, see `vendor/graft/VENDORED.md`)
resolves config in this order, logging the winner at startup:

1. explicit `--config PATH`
2. `$GRAFT_CONFIG` env var
3. `$HOME/.graft/config.yaml` (if present)
4. built-in defaults

`graftd --check-config [PATH]` loads config through the same chain, prints
the resolved values, and exits 0/1 — no socket, no db. `heimdall doctor`
uses it for validation.

## Graft-cpp fork

`vendor/graft/` is a git subtree of the `graft-cpp` fork pinned to tag
`v0.1.0-heimdall.2` (fork delta: config fallback chain + `--check-config`).
See `vendor/graft/VENDORED.md` for the update procedure (`git subtree pull`).

## Troubleshooting

- **`launchctl bootstrap failed: 5`** — a daemon was mid-unload. Re-run
  `heimdall setup`; it waits for unload and retries.
- **Daemon "running" but socket missing** — graftd binds the socket only
  after loading the model (~1-2min for bge-m3 on Metal). Watch
  `~/.graft/graftd.log` for `listening on ...`.
- **CPU-only fallback** — `heimdall setup --accel cpu --skip-daemon`, then
  start manually: `~/.local/bin/graftd --config ~/.graft/config.yaml`.
  (Metal/CUDA need matching llama.cpp build backends; the CPU path always works.)
- **Stale socket from a dead daemon** — `rm /tmp/graft-default.sock` and
  re-run setup.
