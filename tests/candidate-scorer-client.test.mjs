// Deterministic protocol/contract tests only: scripted scores, no model, index,
// retrieval, quality measurements, installed daemon, or third-party Python deps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { plainPython } from "./lib/python.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, "../bin/candidate_scorer.py");
const FIXTURE = join(HERE, "fixtures/scorer-client/contract.py");
const PYTHON = plainPython();

function runContract(method) {
  // Do not use os.tmpdir(): macOS's /var/folders/... can exhaust sockaddr_un.
  // Every socket, HOME, and scratch file lives in this short, private directory.
  const root = mkdtempSync("/tmp/hsc-");
  chmodSync(root, 0o700);
  try {
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(HEIMDALL|GRAFT|PYTHON)/.test(key)
      && !["HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].includes(key),
    ));
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_RUNTIME_DIR: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    });
    const child = spawnSync(PYTHON, [
      "-I", "-S", "-B", FIXTURE, CLIENT, root, method,
    ], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    assert.equal(child.error, undefined,
      `stdlib-only Python fixture failed to run: ${child.error?.message}\n${child.stdout || ""}\n${child.stderr || ""}`);
    assert.equal(child.signal, null,
      `fixture terminated by ${child.signal}\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.status, 0,
      `${method}\n${child.stdout}\n${child.stderr}`);
  } finally {
    // Also runs for failed assertions, child timeouts, and fixture exceptions.
    // The fixture has only threads; killing its one process leaves no children.
    rmSync(root, { recursive: true, force: true });
  }
}

const CASES = [
  ["real AF_UNIX exchange uses little-endian framing and preserves Unicode, IDs, raw zero and missing evidence", "test_wire_unicode_and_missingness"],
  ["CE-primary permutation uses stable original-rank ties, not vector or lexical magnitudes", "test_ce_primary_and_stable_ties"],
  ["nonempty opaque IDs are not trimmed or Unicode-normalized", "test_opaque_whitespace_ids"],
  ["fragmented replies and legal non-minimal JSON-shaped MessagePack encodings are accepted", "test_fragmented_and_wide_encodings"],
  ["disabled, unavailable, failed and deadline results preserve original order and observed signals", "test_degraded_original_order"],
  ["zero candidates is a successful empty operation", "test_empty_success"],
  ["25 candidates and exact UTF-8 byte limits fit a bounded request larger than the reply cap", "test_maximum_valid_request"],
  ["outer envelope, version, status, method, boolean and count shapes are validated", "test_envelope_and_result_shapes"],
  ["wrong IDs, membership, original ranks, permutations and unstable CE ties are rejected", "test_identity_and_rank_validation"],
  ["signals must be present and finite-or-null with honest CE status, source and document-byte association", "test_signal_validation"],
  ["duplicate map keys and non-string map keys are rejected at every response layer", "test_map_keys"],
  ["malformed, truncated and non-JSON MessagePack plus non-UTF8 strings fail safely", "test_malformed_messagepack"],
  ["response frames enforce the 1 MiB cap, reject invalid headers early and detect EOF", "test_response_frame_limits"],
  ["deep or excessive-item responses and malicious container lengths are bounded", "test_complexity_limits"],
  ["invalid query/candidate shapes, byte limits, duplicates and nonfinite inputs never open a socket", "test_invalid_inputs_no_connection"],
  ["invalid timeouts and absent/invalid explicit socket paths never open a socket", "test_invalid_transport_inputs_no_connection"],
  ["the explicit socket receives one scoring frame only: no health probe, retry, spawn or alternate socket", "test_no_probe_retry_or_fallback"],
  ["trickling header bytes cannot renew the absolute deadline", "test_trickled_header_deadline"],
  ["trickling body bytes cannot renew the absolute deadline", "test_trickled_body_deadline"],
  ["one absolute budget covers connect, send and all receives, including expiry between phases", "test_deadline_across_connect_send_receive"],
  ["preparation consumes the enclosing absolute deadline and cannot start late I/O", "test_enclosing_deadline_includes_preparation"],
  ["diagnostics use safe error codes without raw query/document or daemon error contents", "test_safe_diagnostics"],
];

describe("candidate scorer client — isolated stdlib wire contract", { concurrency: false }, () => {
  for (const [description, method] of CASES) {
    it(description, () => runContract(method));
  }
});
