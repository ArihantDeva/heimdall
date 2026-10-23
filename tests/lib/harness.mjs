// harness.mjs — let a `bun:test`-flavoured test file run under `node --test`.
//
// WHY (2026-10-23, CI red): three suites imported `bun:test` while package.json
// runs `node --test "tests/**/*.test.mjs"`. Under node, importing `bun:test`
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'bun:'") at MODULE
// LOAD, so the whole FILE failed — not one assertion, the entire suite — in both
// CI jobs. Locally it stayed invisible because bun is on the operator's PATH
// (mise pins bun 1.4.0), so nothing ever forced the question "which runner
// actually executes this file?".
//
// This is a shim, not a rewrite: the suites' assertions were fine, and converting
// them to `node:assert` would churn the comments recording what each one pins.
// It exports the `bun:test` surface these files use, on top of node:test:
//
//   describe / it / test            with bun's numeric-timeout third argument
//   describe.skipIf / it.skipIf     bun-only; node:test has no equivalent
//   expect(...)                     the matcher subset below, plus `not`
//
// Deliberately NOT a general polyfill. An unimplemented matcher THROWS rather
// than no-opping, because a silent pass is worse than the import error it
// replaces — silent passes are how a suite goes green while testing nothing.
import assert from "node:assert/strict";
import nodeTest, {
  after as nodeAfter,
  before as nodeBefore,
  describe as nodeDescribe,
  it as nodeIt,
} from "node:test";

// Every registrar is re-wrapped from ITSELF, never from a shared closure: the
// first version of this shim closed over the plain registrar, so `describe.skip`
// silently became `describe` and a skipped suite ran for real. Respecting the
// modifier is the whole point, so the registrar is threaded explicitly.
function adapt(registrar) {
  // bun: `it(name, fn, 180_000)`     third arg is a TIMEOUT IN MS.
  // node: `it(name, { timeout: 180_000 }, fn)`   third arg is an OPTIONS OBJECT.
  // Passing bun's number straight through makes node read it as options and
  // drop the deadline, so translate.
  const call = (name, a, b) => {
    if (typeof a === "number") return registrar(name, { timeout: a }, b);
    return registrar(name, a, b);
  };

  const wrapped = (name, a, b) => call(name, a, b);

  for (const key of ["skip", "only", "todo"]) {
    // `describe.skip` etc. are functions on node's registrar whose names are
    // properties of the wrapper they return, so borrow them.
    const modifier = registrar[key];
    if (typeof modifier === "function") {
      // Bind the modification ONCE, then adapt the result, so `.skip.only`-style
      // chains keep working and the skip flag is never lost.
      wrapped[key] = (...args) => adapt(modifier(...args));
    }
  }

  // bun's skipIf/runIf take a boolean and return a variant of the SAME
  // registrar. A false predicate must still SKIP with a reported "# SKIP", never
  // be silently omitted: an omitted suite reports nothing at all, which reads as
  // "nothing to fix" instead of "not verified here".
  const when = (cond, want) => {
    const on = typeof cond === "function" ? !!cond() : !!cond;
    if (on === want) return adapt(registrar);
    const skip = registrar.skip;
    if (typeof skip !== "function") throw new Error("harness.mjs: node:test has no .skip");
    return adapt(skip);
  };
  wrapped.skipIf = (cond) => when(cond, false);
  wrapped.runIf = (cond) => when(cond, true);

  return wrapped;
}

const it = adapt(nodeIt);
const test = adapt(nodeTest);
const describeBase = adapt(nodeDescribe);

// A describe BODY runs at REGISTRATION time, before any test executes. If it
// throws — most easily from an `expect()` placed at the top of the block — node
// reports the block as one failing suite and registers NONE of its children.
// Measured on node 26.10: five intended `it()`s became zero, and the run
// printed `✖ failing tests: ✖ block B` followed by `ℹ fail 0`. The process exit
// code is 1, so CI is not fooled, but anything reading the COUNTS (including
// this project's own experiment tooling) sees a clean run.
//
// So the wrapper converts a registration throw into a normal failing test, which
// is counted, named, and attributable to the block that lost its children:
//   ✖ describe "block B" threw while registering — 5 intended tests never ran
// A block that loses its tests is exactly as dangerous as a swallowed exception,
// and for the same reason: the run looks green while verifying nothing.
// Wrap the BODY, not the registrar: whichever variant ends up executing it
// (plain, .only, .runIf(true)) the guard applies, and the ones that never
// execute it (.skip, .skipIf(true), .todo) are untouched by construction.
function guardBody(body) {
	if (typeof body !== "function") return body;
	return (...a) => {
		try {
			return body(...a);
		} catch (err) {
			nodeIt(`describe threw while registering — its tests never ran`, () => {
				throw err;
			});
			// Not rethrown: node's own suite-level error is not counted in the
			// run's fail tally, and rethrowing would double-report without
			// adding a counted failure. The nodeIt above IS the counted one.
			return undefined;
		}
	};
}

// A skipped describe NEVER RUNS its body, so node cannot count what was in it:
//     describe.skip("x", () => { it("a",...); it("b",...); it("c",...); });
// reports  ℹ tests 0   ℹ skipped 0  — the three tests do not exist.
// Measured on node 26.10. Consequence for this repo (2026-10-23): the suite
// printed `skipped 3` while SIXTEEN child tests sat behind those three suites
// (14 product tests + 2 harness tests). Anyone reading "3 skipped" concludes
// three assertions were deferred; the real figure was 16.
//
// The body genuinely must not run — that is what skipping means — so the child
// names cannot be recovered. What CAN be fixed is the vanishing: register the
// deferred block as one skipped test that carries its name and reason, so the
// tally shows a deferral instead of nothing.
// A LEAF test is the only shape node counts when skipped. A skipped SUITE
// reports `ℹ skipped 0` no matter how many children it held (verified on node
// 26.10 with describe.skip and with describe(name, {skip}, ...)), which is the
// vanishing this function exists to prevent.
function deferred(name, reason) {
	const why = reason ? String(reason) : "canRun predicate was false";
	nodeIt(`${name} — DEFERRED, its tests are not in the tally (${why})`,
		{ skip: why }, () => {});
}
const describe = (name, body, ...rest) =>
	describeBase(name, guardBody(body), ...rest);

// CAREFUL: node:test has NO describe.skipIf — it is bun-only, and adapt() above
// implemented it on the wrapper. Copying modifiers off `describeBase` (which has
// only skip/only/todo) therefore DROPPED skipIf, and three suites in this repo
// call it. Evaluate the predicate here instead of delegating to node.
const SKIP_KEYS = ["skip", "only", "todo"];
for (const key of SKIP_KEYS) {
	const mod = describeBase[key];
	if (typeof mod === "function") {
		// `describe.skip` still drops children, so route it through deferred() to
		// keep the count visible. only/todo keep node's own semantics.
		describe[key] = key === "skip"
			? (n) => deferred(n)
			: (...args) => (typeof args[1] === "function"
				? mod(args[0], guardBody(args[1]), ...args.slice(2))
				: mod(...args));
	}
}
// bun's skipIf/runIf take a boolean and RETURN A REGISTRAR of the same kind.
for (const [key, want] of [["skipIf", false], ["runIf", true]]) {
	describe[key] = (cond) => {
		const on = typeof cond === "function" ? !!cond() : !!cond;
		if (on !== want) {
			return Object.assign(
				(n, b, ...r) => (key === "skipIf"
					? deferred(n)
					: guardBody(b) === b ? undefined : describeBase(n, guardBody(b), ...r)),
				{ skip: describeBase.skip, only: describeBase.only, todo: describeBase.todo },
			);
		}
		return Object.assign(
			(n, b, ...r) => describeBase(n, guardBody(b), ...r),
			{ skip: describeBase.skip, only: describeBase.only, todo: describeBase.todo },
		);
	};
}

// bun spells these beforeAll/afterAll; node:test spells them before/after. Both
// register on the enclosing describe, so the alias is exact, not approximate.
const beforeAll = nodeBefore;
const afterAll = nodeAfter;

export { afterAll, beforeAll, describe, it, test };

/**
 * bun/jest `expect` subset, narrowed to the matchers these suites use.
 *
 * `not` is an object, not a function, matching bun: `expect(x).not.toBe(y)`.
 */
export function expect(actual) {
  const has = (want) =>
    typeof actual === "string"
      ? actual.includes(want)
      : Array.from(actual ?? []).includes(want);

  const api = {
    toBe: (want) => assert.strictEqual(actual, want),
    toEqual: (want) => assert.deepEqual(actual, want),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
    toContain: (want) => assert.ok(has(want), `expected to contain ${String(want)}`),
    toMatch: (re) => assert.match(actual, re),
    toBeGreaterThan: (want) => assert.ok(actual > want, `expected ${actual} > ${want}`),
    toBeGreaterThanOrEqual: (want) => assert.ok(actual >= want, `expected ${actual} >= ${want}`),
    toBeLessThan: (want) => assert.ok(actual < want, `expected ${actual} < ${want}`),
    toBeLessThanOrEqual: (want) => assert.ok(actual <= want, `expected ${actual} <= ${want}`),
    not: {
      toBe: (want) =>
        assert.ok(!Object.is(actual, want), `expected not ${String(want)}, got ${String(actual)}`),
      toEqual: (want) => assert.notDeepStrictEqual(actual, want),
      toContain: (want) => assert.ok(!has(want), `expected NOT to contain ${String(want)}`),
      toMatch: (re) => assert.doesNotMatch(actual, re),
      toBeTruthy: () => assert.ok(!actual),
    },
  };

  // Unimplemented members must FAIL LOUDLY. A property resolving to undefined
  // turns `expect(x).resolves.toBe(y)` into a no-op.
  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(
        `harness.mjs: expect().${String(prop)} is not implemented — ` +
        "use node:assert, or add the matcher here deliberately",
      );
    },
  });
}
