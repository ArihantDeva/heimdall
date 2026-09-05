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
4. **Build** — canonical path is `~/.local/bin/graftd`. If it probes ok,
   nothing to do. If it is broken or missing but another candidate probes ok
   (`HEIMDALL_BUILD_DIR/graftd` → `~/.heimdall/build/graft/graftd` →
   `~/Repos/graft-cpp/build/graftd`), that binary is copied atomically to
   `~/.local/bin/graftd` (a broken existing canonical is kept as
   `graftd.bak-<timestamp>`). If no working binary is found anywhere, fetches
   llama.cpp at pinned tag `b10760` via CMake `FetchContent`, compiles it as
   static libraries, and installs the resulting self-contained binary to
   `~/.local/bin/graftd`. `HEIMDALL_NO_BUILD=1` skips the compile step.
   `--graftd PATH` probes the supplied binary before copying (broken binary
   = one-line error, nothing written).
5. **Daemon** — plist written to
   `~/Library/LaunchAgents/com.graft.daemon.plist`, loaded via
   `launchctl bootout` → `bootstrap` (waits for unload; retries bootstrap).
   `--skip-daemon` prints the manual start command instead.
6. **Verify** — `heimdall doctor` checks: config present, `graftd
   --check-config` passes, model file present + ≥10MB, plist valid, daemon
   running.

## Hardware matrix (auto-detected defaults)

| Platform | Accel | Threads | Instances | Notes |
|---|---|---|---|---|
| Apple Silicon (darwin + `hw.optional.arm64=1`) | `metal` | physical cores | 2 | llama.cpp Metal backend |
| Intel mac | `cpu` | physical cores | 2 | no discrete-GPU detection |
| Linux + `nvidia-smi` | `cuda` | physical cores | 2 | requires llama.cpp built with `-DGGML_CUDA=ON` |
| Linux, no NVIDIA | `cpu` | physical cores | 2 | |

Linux physical cores: counted from `/proc/cpuinfo` (unique physical-id ×
core-id pairs), falling back to `lscpu -p=CORE,SOCKET`, `nproc`, then
`os.cpus()`.

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

## Build from source / cache

The npm tarball ships `vendor/graft/` with `third_party/{BLAKE3,mpack,sqlite-vec}`; llama.cpp (pinned `b10760`) is cloned shallow at first build into the build cache (dev checkout: `vendor/graft/third_party/llama.cpp`; npm install: `~/.heimdall/build/llama.cpp`); subsequent builds are offline.

### Prerequisites

Install prerequisites — one command per platform:

- macOS — Xcode Command Line Tools + `brew install cmake pkg-config libyaml sqlite`
- Debian/Ubuntu — `apt install cmake pkg-config build-essential git libsqlite3-dev libyaml-dev`
- Fedora/Amazon Linux — `dnf install gcc gcc-c++ make cmake git pkgconf-pkg-config sqlite-devel libyaml-devel`

`git` is required — llama.cpp is cloned at first build.

`vendor/graft/CMakeLists.txt` probes these exact pkg-config modules:
`pkg_check_modules(SQLITE REQUIRED sqlite3)` and
`pkg_check_modules(YAML REQUIRED yaml-0.1)`. Package names differ per distro — see table.

| Dependency | macOS (`brew`) | Debian/Ubuntu (`apt`) | Fedora/Amazon Linux (`dnf`) |
|---|---|---|---|
| cmake | `cmake` | `cmake` | `cmake` |
| C/C++ compiler | Xcode CLT (`xcode-select --install`) | `build-essential` | `gcc gcc-c++ make` |
| git | Xcode CLT | `git` | `git` |
| pkg-config | `pkg-config` | `pkg-config` | `pkgconf-pkg-config` |
| sqlite3 (`sqlite3`) | `sqlite` | `libsqlite3-dev` | `sqlite-devel` |
| libyaml (`yaml-0.1`) | `libyaml` | `libyaml-dev` | `libyaml-devel` |

### Build directories

| Context | Build dir | llama.cpp source |
|---|---|---|
| Dev checkout (repo has `.git`) | `vendor/graft/build` | `vendor/graft/third_party/llama.cpp` |
| npm-installed package | `~/.heimdall/build/graft` | `~/.heimdall/build/llama.cpp` |

`HEIMDALL_BUILD_DIR` and `HEIMDALL_LLAMA_SRC` override these paths.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HEIMDALL_NO_BUILD` | — | `1` = skip build in `setup` and postinstall |
| `HEIMDALL_BUILD_TIMEOUT_MS` | `1800000` | cmake configure + build timeout (ms) |
| `HEIMDALL_BUILD_JOBS` | `min(cores, 4)` | parallel build jobs |
| `HEIMDALL_BUILD_DIR` | see above | override build directory |
| `HEIMDALL_LLAMA_SRC` | see above | override llama.cpp source directory |

Build log: `~/.heimdall/bootstrap.log`.

### Probe semantics

`probeGraftd` runs `graftd --check-config` on a minimal rendered config.
Exit 0 with `model_path:` in stdout = working binary. Probe result — not
file mtime — determines what action is taken:

- `~/.local/bin/graftd` probes ok → nothing to do (source: `existing`).
- `~/.local/bin/graftd` broken or absent, but another candidate probes ok
  (build cache, `~/Repos/graft-cpp/build`) → that binary is copied into
  `~/.local/bin/graftd`; broken canonical is kept as `graftd.bak-<timestamp>`
  (source: `installed`).
- Nothing works → build from source and install (source: `built`).

### Binary backup

`installGraftd` renames an existing `~/.local/bin/graftd` to
`~/.local/bin/graftd.bak-<timestamp>` before writing the new file. If the
post-install probe fails, the backup is restored.

### `graft` CLI copy rule

The built `graft` CLI is copied to `~/.local/bin/graft` only if no file
already exists there — never overwritten.

### Note on portability

`graftd` is compiled for the host platform. Do not copy it between machines
with different CPU architectures or operating systems.

## Graft-cpp fork

`vendor/graft/` is a git subtree of the `graft-cpp` fork pinned to tag
`v0.1.0-heimdall.2`. Fork delta: config fallback chain + `--check-config` +
static llama.cpp linkage. The `CMakeLists.txt` fetches llama.cpp at pinned
tag `b10760` via `FetchContent` and builds it as static libraries — `graftd`
is self-contained with no dynamic `libllama`/`libggml` dependency. The delta
pending upstream push, the re-pin procedure, and cache variable reference are
in `vendor/graft/VENDORED.md`.

## Troubleshooting

- **`dyld: Library not loaded: @rpath/libllama.0.dylib`** — the installed
  `graftd` was built against a dynamic llama.cpp with a build-tree RPATH (a
  pre-0.9.0 binary or a manual build that did not use static linkage). Fix:
  `heimdall setup` rebuilds a self-contained static binary. Manual steps:
  ```bash
  cmake -S vendor/graft -B vendor/graft/build -DCMAKE_BUILD_TYPE=Release
  cmake --build vendor/graft/build --target graftd --parallel 4
  heimdall setup --graftd vendor/graft/build/graftd
  ```
  Verify the installed binary has no dynamic llama/ggml deps:
  ```bash
  # macOS
  otool -L ~/.local/bin/graftd | grep -Ei 'llama|ggml'   # → no output
  otool -l ~/.local/bin/graftd | grep -A2 LC_RPATH        # → no output
  # Linux
  ldd ~/.local/bin/graftd | grep -Ei 'llama|ggml'         # → no output
  readelf -d ~/.local/bin/graftd | grep RPATH              # → no output
  ```
- **SETUP NEEDED after `npm install`** — prerequisites were missing at
  install time. Install them (see "Build from source / cache" above), then:
  `heimdall setup`. The rest of heimdall (harness wiring, `init`, `insert`)
  already works; only `search` and `doctor` need `graftd`.
- **Slow builds / timeouts** — increase parallelism or the timeout:
  `HEIMDALL_BUILD_JOBS=8 HEIMDALL_BUILD_TIMEOUT_MS=3600000 heimdall setup`.
  The first build fetches and compiles llama.cpp; subsequent builds are
  incremental and much faster.
- **Stale daemon after binary upgrade** — after `heimdall setup` replaces
  `graftd`, kick the daemon:
  `launchctl kickstart -k gui/$UID/com.graft.daemon`, then
  `heimdall doctor`.
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
- **cmake: sqlite3 not found by pkg-config (macOS)** — Homebrew's sqlite is
  keg-only; if cmake reports it missing, run:
  ```bash
  export PKG_CONFIG_PATH="$(brew --prefix sqlite)/lib/pkgconfig:$PKG_CONFIG_PATH"
  ```
  then retry `heimdall setup`.
