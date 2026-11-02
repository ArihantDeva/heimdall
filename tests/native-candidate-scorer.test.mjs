// Native UNIT mechanics only. No quality harness, real index, model, installs,
// CMake or downloaded sources. GitHub's system compiler links production C with
// strict CE/storage/embed stubs and the already-vendored MPack implementation.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const graft = join(root, "vendor/graft");
const mpack = join(graft, "third_party/mpack/src/mpack");
const source = (path) => readFileSync(join(graft, path), "utf8");
const compiler = [process.env.CC, "cc", "gcc", "clang"]
	.filter((name) => name && !/\s/.test(name))
	.find((name) => {
		const probe = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 5000 });
		return !probe.error && probe.status === 0;
	});
const skip = !compiler
	? "system C compiler (cc/gcc/clang) unavailable; native fixture NOT compiled or executed; genuine model runtime unverified"
	: process.platform === "win32" ? "POSIX socketpair unit fixture requires Linux/macOS" : false;
let work;
let binary;

const productionSources = [
	"src/rerank/candidate_scorer.c",
	"src/rerank/score_candidates.c",
	"src/rerank/rerank.c",
	"src/retrieve/retrieve.c",
	"src/daemon/dispatch.c",
	"src/daemon/wire.c",
	// The real existing title-trigram implementation; CE/config are stubbed.
	"src/verify/verify.c",
	"src/common/error.c",
];
const mpackSources = ["common", "expect", "node", "platform", "reader", "writer"]
	.map((name) => join(mpack, `mpack-${name}.c`));
const flags = [
	"-std=c11", "-O0", "-Wall", "-Wextra", "-Wno-unused-parameter",
	"-D_POSIX_C_SOURCE=200809L", "-I", join(graft, "include"), "-I", mpack,
];
function reportSourceFailure(title, text) {
	if (process.env.GITHUB_ACTIONS !== "true") return;
	// Only this fixture's public-source compile/assert diagnostics, never a
	// workflow log or environment dump. Standard annotations let CI failures
	// be inspected without granting Actions-log access or exposing input data.
	const clean = String(text).split(root).join("<repo>").slice(0, 6000)
		.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
	console.error(`::error title=${title}::${clean}`);
}
function compile(args, description) {
	const result = spawnSync(compiler, args, {
		cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		reportSourceFailure("Native scorer compile contract", `${description}\n${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);
	}
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${description}\n${result.stdout}\n${result.stderr}`);
}

before(() => {
	if (skip) return;
	work = mkdtempSync(join(tmpdir(), "heimdall-native-candidate-unit-"));
	binary = join(work, "native-candidate-scorer-unit");
	// Also compile the production OS-monotonic branch without the test clock.
	compile([...flags, "-c", join(graft, "src/rerank/candidate_scorer.c"),
		"-o", join(work, "production-clock.o")], "production monotonic clock TU");
	compile([...flags, "-DMG_CANDIDATE_TEST_CLOCK=1",
		join(root, "tests/fixtures/native-candidate-scorer.c"),
		...productionSources.map((path) => join(graft, path)), ...mpackSources,
		"-lm", "-pthread", "-o", binary], "actual native scorer unit fixture");
});
after(() => {
	if (work) rmSync(work, { recursive: true, force: true });
});

for (const [group, description] of [
	["core", "identity, fixed CE-primary permutations, stable ties, raw cosine and real bodies"],
	["states", "disabled/effective CE opt-in, CPU-only, failure, missingness and monotonic deadlines"],
	["invalid", "strict shapes, duplicate keys/IDs, UTF-8/NUL, nonfinite inputs and malformed frames"],
	["bounds", "exact byte/count limits, default budget and successful empty request"],
	["serialization", "exact v1 result schema, input order, diagnostic retention and finite-or-null floats"],
	["retrieve", "frozen RRF membership/ranks/scores, per-ID evidence, first-25 window and unchanged tails"],
	["wire", "actual dispatch and little-endian MessagePack framing over private socketpair"],
]) {
	test(`native candidate scorer: ${description}`, { skip }, () => {
		const result = spawnSync(binary, [group], {
			cwd: work, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
		});
		if (result.error || result.status !== 0) {
			reportSourceFailure("Native scorer unit contract", `${group}\n${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);
		}
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${group}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /mock CE; genuine model runtime unverified/);
	});
}

test("native scorer compiler coverage is mandatory in GitHub CI, never an unearned green skip", () => {
	if (process.env.GITHUB_ACTIONS === "true") {
		assert.ok(compiler, "CI must provide its existing system compiler; do not install one or waive native coverage");
	}
});

test("native scorer source boundary: compute-only borrowing, additive wire dispatch and unchanged retrieval depth", () => {
	const core = source("src/rerank/candidate_scorer.c");
	const handler = source("src/rerank/score_candidates.c");
	for (const text of [core, handler]) {
		assert.doesNotMatch(text, /\bmg_storage_\w+\s*\(/);
		assert.doesNotMatch(text, /\bmg_embed_\w+\s*\(/);
		assert.doesNotMatch(text, /\b(?:mg_ce_try_enable|mg_verify_init|mg_embed_init|llama_model_load_from_file|mg_ce_score_nli)\s*\(/);
		assert.doesNotMatch(text, /\bmg_score_fuse\s*\(/);
	}
	assert.match(core, /mg_ce_score_pair\(r->verify_ctx_for_ce, query, inputs\[i\]\.document/);
	assert.match(core, /CLOCK_MONOTONIC/);
	assert.match(core, /hardware_accel/);
	assert.match(core, /rerank_w_ce/);
	assert.match(core, /mg_text_trigram_jaccard_checked\(/);
	assert.match(handler, /isfinite\(value\)/);
	assert.match(source("include/graft/candidate_scorer.h"), /MG_CANDIDATE_MAX_COUNT\s+25u/);
	assert.match(source("src/daemon/dispatch.c"), /case MG_OP_SCORE_CANDIDATES:\s*herr = mg_op_score_candidates/);
	assert.match(source("src/daemon/wire.c"), /MG_FRAME_MAX \(16u \* 1024u \* 1024u\)/);
	const retrieve = source("src/retrieve/retrieve.c");
	assert.match(retrieve, /MG_RETRIEVE_PER_LIST_K\s+50/);
	assert.match(retrieve, /mg_candidate_score\(/);
	assert.doesNotMatch(retrieve, /mg_rerank_batch\(/);
	assert.doesNotMatch(retrieve, /cands\[i\]\.rrf\s*=/);
	assert.match(retrieve, /node->body && node->body\[0\] \? node->body : node->title/);
});

test("native scorer fixture links vendored/native sources only; test clock and runtime limits are explicit", () => {
	assert.ok(productionSources.includes("src/rerank/score_candidates.c"));
	assert.ok(productionSources.includes("src/retrieve/retrieve.c"));
	assert.ok(productionSources.includes("src/daemon/dispatch.c"));
	assert.ok(productionSources.includes("src/daemon/wire.c"));
	assert.ok(productionSources.every((path) => !/storage|embed\/|config\/|crossencoder\.c/.test(path)));
	const fixture = readFileSync(join(root, "tests/fixtures/native-candidate-scorer.c"), "utf8");
	assert.match(fixture, /int mg_ce_score_pair\(/);
	assert.match(fixture, /int mg_candidate_test_now_ms\(/);
	assert.match(fixture, /no_side_effects/);
	assert.match(fixture, /socketpair\(AF_UNIX/);
	assert.doesNotMatch(fixture, /#include\s*[<"](?:llama|sqlite3|yaml)\.h/);
	const docs = readFileSync(join(root, "docs/shared-daemon-scorer.md"), "utf8");
	assert.match(docs, /genuine.*runtime.*unverified/i);
	assert.match(docs, /cannot.*preempt/i);
});
