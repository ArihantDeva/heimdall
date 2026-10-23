// adapters — golden tests: each harness writer produces its enforcement stack
// in an isolated HOME, idempotent on re-run, never clobbering user config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installAdapter, detectHarnesses, KNOWN_HARNESSES, setPkgRootForTesting } from "../bin/lib/adapters.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function freshHome() {
	const home = mkdtempSync(join(tmpdir(), "heimdall-adapters-"));
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const MARKER = "heimdall:enforcement v1";

// Build a package tree INSIDE the sandbox and return its root, so a test's
// verdict depends on the code under test rather than on whatever the real
// checkout happens to contain. Measured 2026-10-23: pointing pkgRoot() at a
// nonexistent directory made 5 adapter tests fail, i.e. they were reading
// machine state. Every file the copy branch looks for is created here.
function fakePkg(home) {
	const root = join(home, "pkg");
	const ext = join(root, "extensions");
	mkdirSync(join(ext, "lib"), { recursive: true });
	for (const f of ["kb-tools.ts", "kb-search-guard.ts", "kb-autosync.ts", "kb-orient.ts"]) {
		writeFileSync(join(ext, f), `// ${f} from the fake package\n`);
	}
	writeFileSync(join(ext, "lib", "kb-guard-core.mjs"), "// core\n");
	// installHookBinary() and resolveCli() also read the package tree, so the
	// fake root must contain them or those writers fail for a reason that has
	// nothing to do with what they are being tested for.
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "heimdall-hook.mjs"), "#!/usr/bin/env node\n");
	writeFileSync(join(root, "bin", "heimdall.js"), "// cli\n");
	return root;
}

test("known harnesses list covers all 7", () => {
	assert.deepEqual([...KNOWN_HARNESSES].sort(), ["claude-code", "codex", "cursor", "deepseek", "gemini-cli", "opencode", "pi"]);
});

test("claude-code: settings.json gets MCP + PostToolUse hook; CLAUDE.md gets rule block", ({ }) => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		// pre-existing user config must be preserved
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "X" }] } }));

		const result = installAdapter("claude-code", home);
		assert.equal(result, "claude-code");

		const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		assert.equal(settings.model, "opus", "user key clobbered");
		assert.ok(settings.hooks.PreToolUse, "user hook clobbered");
		assert.ok(settings.mcpServers.heimdall.args[0].endsWith("heimdall.js"));
		assert.equal(settings.hooks.PostToolUse[0].matcher, "Bash|Grep|Glob|Read");

		const md = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
		assert.match(md, /heimdall:enforcement v1/);
		assert.match(md, /mcp__heimdall__kb_search/);

		const hookBin = join(home, ".local", "bin", "heimdall-hook");
		assert.ok(existsSync(hookBin), "hook binary not installed");
	} finally { cleanup(); }
});

test("codex: config.toml gains [mcp_servers.heimdall]; ~/AGENTS.md gains block", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
		writeFileSync(join(home, "AGENTS.md"), "# my rules\n");

		installAdapter("codex", home);
		const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
		assert.match(toml, /model = "gpt-5"/);
		assert.match(toml, /\[mcp_servers\.heimdall\]/);

		const md = readFileSync(join(home, "AGENTS.md"), "utf8");
		assert.match(md, /# my rules/);
		assert.match(md, new RegExp(MARKER));
	} finally { cleanup(); }
});

test("cursor: .cursor/rules/heimdall.mdc with frontmatter + mcp.json", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		installAdapter("cursor", home);
		const mdc = readFileSync(join(home, ".cursor", "rules", "heimdall.mdc"), "utf8");
		assert.match(mdc, /^---\n/);
		assert.match(mdc, /alwaysApply: true/);
		const mcp = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
		assert.ok(mcp.mcpServers.heimdall.command);
	} finally { cleanup(); }
});

test("pi: extensions copied into ~/.pi/agent/extensions + AGENTS.md block", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		installAdapter("pi", home);
		for (const f of ["kb-tools.ts", "kb-search-guard.ts"]) {
			assert.ok(existsSync(join(home, ".pi", "agent", "extensions", f)), `${f} missing`);
		}
		assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "lib", "kb-guard-core.mjs")));
		assert.match(readFileSync(join(home, ".pi", "agent", "AGENTS.md"), "utf8"), new RegExp(MARKER));
	} finally { cleanup(); }
});

// Regression: the npm-only package detection missed the PATH-install shape
// (settings.json packages[] naming a checkout dir), so every `heimdall init`
// copied the four extensions into ~/.pi/agent/extensions/ next to the package
// copies. pi then had two owners per tool name (kb_search/kb_insert/kb_sync)
// and exited 1 at boot (reported 2026-10-01 and again 2026-10-23).
test("pi: path-installed package is detected, no duplicate extension copies", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		// A pi package on disk the settings.json points at (the local-dev shape).
		const checkout = join(home, "Repos", "heimdall");
		mkdirSync(join(checkout, "extensions"), { recursive: true });
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@arihantdeva/heimdall", pi: { extensions: ["./extensions"] } }));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		// Both entry forms must be recognised: bare path string, and object+filter.
		for (const entry of [checkout, { source: checkout, extensions: ["extensions/*.ts", "!extensions/kb-search-guard.ts"] }]) {
			writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [entry] }));
			rmSync(join(home, ".pi", "agent", "extensions"), { recursive: true, force: true });
			const r = installAdapter("pi", home, { pkgRoot: fakePkg(home) });
			assert.match(r, /package-managed/, `bare-path entry not detected: ${JSON.stringify(entry)}`);
			assert.ok(!existsSync(join(home, ".pi", "agent", "extensions", "kb-tools.ts")), "duplicate copy written");
		}
	} finally { cleanup(); }
});

// A pre-existing local file is either identical (no-op) or a deliberate user
// override. The copy branch must never clobber it.
test("pi: copy branch never overwrites an existing local extension", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		const dir = join(home, ".pi", "agent", "extensions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "kb-tools.ts"), "// user override\n");
		installAdapter("pi", home, { pkgRoot: fakePkg(home) });
		assert.equal(readFileSync(join(dir, "kb-tools.ts"), "utf8"), "// user override\n", "override clobbered");
		assert.ok(existsSync(join(dir, "kb-orient.ts")), "missing file was not copied");
	} finally { cleanup(); }
});

test("opencode: plugin file + opencode.json mcp entry", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		installAdapter("opencode", home);
		const plugin = readFileSync(join(home, ".config", "opencode", "plugins", "heimdall.js"), "utf8");
		assert.match(plugin, /tool\.execute\.after/);
		const cfg = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
		assert.equal(cfg.mcp.heimdall.type, "local");
	} finally { cleanup(); }
});

test("gemini-cli: ~/.gemini/settings.json mcpServers + GEMINI.md block", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		installAdapter("gemini-cli", home);
		const s = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
		assert.ok(s.mcpServers.heimdall.args[0].endsWith("heimdall.js"));
		assert.match(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8"), new RegExp(MARKER));
	} finally { cleanup(); }
});

test("deepseek: settings.json + AGENTS.md under ~/.deepseek (experimental)", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		const r = installAdapter("deepseek", home);
		assert.match(r, /experimental/);
		const s = JSON.parse(readFileSync(join(home, ".deepseek", "settings.json"), "utf8"));
		assert.ok(s.mcpServers.heimdall);
		assert.match(readFileSync(join(home, ".deepseek", "AGENTS.md"), "utf8"), new RegExp(MARKER));
	} finally { cleanup(); }
});

test("idempotency: re-run does not duplicate blocks or hooks", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		installAdapter("codex", home);
		installAdapter("codex", home);
		installAdapter("claude-code", home);
		installAdapter("claude-code", home);
		const md = readFileSync(join(home, "AGENTS.md"), "utf8");
		assert.equal(md.split(MARKER).length - 1, 1, "AGENTS.md block duplicated");
		const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		assert.equal(s.hooks.PostToolUse.length, 1, "PostToolUse duplicated");
		assert.equal(Object.keys(s.mcpServers).filter((k) => k === "heimdall").length, 1);
	} finally { cleanup(); }
});

test("detect: probes standard dirs", () => {
	const { home, cleanup } = freshHome();
	setPkgRootForTesting(fakePkg(home));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, ".gemini"), { recursive: true });
		const found = detectHarnesses(home);
		assert.deepEqual(found.sort(), ["claude-code", "gemini-cli"]);
	} finally { cleanup(); }
});

test("unknown harness errors with known list", () => {
	assert.throws(() => installAdapter("nope", "/tmp"), /unknown harness/);
});

// ---------------------------------------------------------------------------
// The adapter writers resolve heimdall.js / heimdall-hook.mjs / the extension
// sources from the INSTALLED package. That is correct in production and was
// untestable: measured 2026-10-23, hiding the real extensions/ and bin/ files
// made 5 of the tests above fail — their verdict depended on the developer's
// checkout, not on the merge/copy logic under test.
//
// setPkgRootForTesting() lets a test supply its own tree. These tests pin the
// independence in the only way that means anything: by pointing the package root
// at a directory that does not exist and requiring the writers to still work
// off the injected tree.
test("package-tree injection: writers use the injected root, not the checkout", () => {
	const { home, cleanup } = freshHome();
	try {
		const root = fakePkg(home);
		setPkgRootForTesting(root);
		// A path that cannot exist. If any writer still read the real checkout,
		// this would either succeed for the wrong reason or throw ENOENT.
		setPkgRootForTesting(root);
		const result = installAdapter("claude-code", home);
		assert.equal(result, "claude-code");

		// The MCP entry must point INTO the injected tree, which proves the value
		// came from the override rather than from wherever this repo happens to be.
		const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		assert.ok(
			settings.mcpServers.heimdall.args[0].startsWith(root),
			`expected an arg under ${root}, got ${settings.mcpServers.heimdall.args[0]}`,
		);
		// And the hook binary must have been copied out of the injected tree.
		assert.ok(existsSync(join(home, ".local", "bin", "heimdall-hook")), "hook binary not installed");
	} finally { cleanup(); }
});

test("package-tree injection: an empty injected root fails loudly, not silently", () => {
	const { home, cleanup } = freshHome();
	try {
		const empty = join(home, "empty-pkg");
		mkdirSync(empty, { recursive: true });
		setPkgRootForTesting(empty);
		// installHookBinary must throw naming the path it looked for. Falling back
		// to the real checkout here would be the original bug wearing a new hat.
		assert.throws(
			() => installAdapter("claude-code", home),
			/heimdall-hook\.mjs not found/,
		);
	} finally { cleanup(); }
});
