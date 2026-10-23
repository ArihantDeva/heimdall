// harness-matcher-fidelity.test.mjs — the harness must mean what bun:test means.
//
// WHY THIS EXISTS (measured 2026-10-23)
// tests/lib/harness.mjs lets bun:test suites run under `node --test` in CI, where
// bun is absent. That only holds if each matcher agrees with bun about what a
// FAILURE is — a matcher that accepts the wrong value cannot fail.
//
// The whole suite rides on ONE line: `import assert from "node:assert/strict"`.
// Switch it to the non-strict "node:assert" and the same code silently degrades:
//     assert.deepEqual([1,2], ["1","2"])   strict: throws   loose: PASSES
//     assert.deepEqual(1, "1")             strict: throws   loose: PASSES
// Every toEqual in the suite would go weak at once, and a weak assertion still
// passes, so nothing would report it. Verified by mutation: importing the loose
// module turns 2 of these tests red.
//
// Equality semantics were confirmed against bun:test directly rather than
// assumed — bun's toEqual is strict about types (fails [1,2] vs ["1","2"] and
// undefined vs null), and bun's toBe is Object.is (fails +0 vs -0, passes
// NaN vs NaN). node's strictEqual agrees on both.
import { describe, it, expect } from "./lib/harness.mjs";

// Does this assertion throw? A matcher that accepts the wrong value is a matcher
// that cannot fail.
function rejects(fn) {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

describe("harness matchers agree with bun:test about failures", () => {
	it("toEqual is strict about types, like bun", () => {
		// The exact cases where node's loose deepEqual would have passed.
		expect(rejects(() => expect([1, 2]).toEqual(["1", "2"]))).toBe(true);
		expect(rejects(() => expect({ a: 1 }).toEqual({ a: "1" }))).toBe(true);
		expect(rejects(() => expect(undefined).toEqual(null))).toBe(true);
		expect(rejects(() => expect(1).toEqual("1"))).toBe(true);
	});

	it("toEqual still accepts genuinely equal values", () => {
		// Over-tightening would turn correct tests red. Depth and arrays included.
		expect(rejects(() => expect([1, 2]).toEqual([1, 2]))).toBe(false);
		expect(rejects(() => expect({ a: { b: [1] } }).toEqual({ a: { b: [1] } }))).toBe(false);
		expect(rejects(() => expect([]).toEqual([]))).toBe(false);
	});

	it("toEqual and not.toEqual do not disagree with each other", () => {
		// They used different equality notions (deepEqual vs notDeepStrictEqual),
		// so a value could be "equal" and "not equal" at the same time.
		const pairs = [
			[[1, 2], ["1", "2"]],
			[undefined, null],
			[{ a: 1 }, { a: "1" }],
			[[1], [1]],
			[{ a: 1 }, { a: 1 }],
		];
		for (const [a, b] of pairs) {
			const positive = rejects(() => expect(a).toEqual(b));
			const negative = rejects(() => expect(a).not.toEqual(b));
			// Exactly one must hold: never both, never neither.
			expect(positive !== negative).toBe(true);
		}
	});

	it("toBe distinguishes +0 from -0 and accepts NaN, like bun", () => {
		// Verified against bun:test directly: expect(0).toBe(-0) fails,
		// expect(NaN).toBe(NaN) passes. node's strictEqual agrees.
		expect(rejects(() => expect(0).toBe(-0))).toBe(true);
		expect(rejects(() => expect(NaN).toBe(NaN))).toBe(false);
		expect(rejects(() => expect("1").toBe(1))).toBe(true);
	});

	it("toBe does not accept a different reference for an object", () => {
		expect(rejects(() => expect({ a: 1 }).toBe({ a: 1 }))).toBe(true);
	});

	it("toContain works on strings and arrays", () => {
		expect(rejects(() => expect("abcdef").toContain("cde"))).toBe(false);
		expect(rejects(() => expect([1, 2, 3]).toContain(2))).toBe(false);
		expect(rejects(() => expect("abcdef").toContain("zzz"))).toBe(true);
		expect(rejects(() => expect([1, 2, 3]).toContain(9))).toBe(true);
	});

	it("toMatch rejects a non-matching subject", () => {
		expect(rejects(() => expect("hello").toMatch(/ell/))).toBe(false);
		expect(rejects(() => expect("hello").toMatch(/xyz/))).toBe(true);
	});

	it("toContain stringifies a nullish subject instead of passing silently", () => {
		// Array.from(undefined ?? []) would make `expect(undefined).toContain(x)`
		// a no-op, i.e. an assertion that cannot fail.
		expect(rejects(() => expect(undefined).toContain("x"))).toBe(true);
	});
});
