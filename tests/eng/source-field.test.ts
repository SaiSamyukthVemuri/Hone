import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ABSENT, PRESENT, absent, isAbsent, isPresent, present, sourceField } from "../../scripts/eng/source-field.mjs";

// ===========================================================================
// CP-005 FOUNDATION-A: structural source presence.
// ===========================================================================
//
// The primitive answers only: was this source property present, and if so what
// exact value did it carry? No authority, no provenance, no reply semantics, no
// cleanliness - those are Foundation-B.
//
// It exists because two retired vehicles encoded absence INSIDE the value
// (`?? null`, then the string "UNKNOWN"), which roughly fourteen production
// consumers silently reinterpret as data.

const roundTrip = (d: unknown) => JSON.parse(JSON.stringify(d));

const REPO = path.resolve(__dirname, "../..");
const IMPL = /\.(ts|tsx|mjs|cjs|js|jsx)$/;

/** Every tracked executable source file, excluding tests and the module itself. */
const productionSources = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => IMPL.test(f))
    .filter((f) => !f.startsWith("tests/"))
    .filter((f) => f !== "scripts/eng/source-field.mjs");

/** Files that reference the module. Simple and readable on purpose - not an AST pass. */
const findImporters = (files: string[], read: (f: string) => string): string[] =>
  files.filter((f) => /source-field(\.mjs)?["'\s)]/.test(read(f)));

describe("presence is structural, not a value", () => {
  it("a missing key is ABSENT", () => {
    expect(sourceField({}, "x")).toEqual({ kind: ABSENT });
    expect(isAbsent(sourceField({}, "x"))).toBe(true);
  });

  it("ABSENT carries no value property at all", () => {
    // Not null, not "", not 0, not "UNKNOWN", not undefined-by-default.
    const d = sourceField({}, "x");
    expect("value" in d).toBe(false);
    expect(Object.keys(d)).toEqual(["kind"]);
  });

  it("PRESENT(null) is real data and is NOT absence", () => {
    const d = sourceField({ x: null }, "x");
    expect(d).toEqual({ kind: PRESENT, value: null });
    expect(isPresent(d)).toBe(true);
    expect(d).not.toEqual(absent());
  });

  it("every falsy value is preserved exactly, uncoerced", () => {
    for (const v of ["", false, 0, NaN, -0]) {
      const d = sourceField({ x: v }, "x");
      expect(isPresent(d)).toBe(true);
      expect(Object.is(d.value, v)).toBe(true);
    }
  });

  it("the string 'UNKNOWN' is ordinary data, not absence", () => {
    // The exact confusion that retired the previous vehicle.
    const d = sourceField({ x: "UNKNOWN" }, "x");
    expect(isPresent(d)).toBe(true);
    expect(d.value).toBe("UNKNOWN");
    expect(d).not.toEqual(absent());
    expect(isAbsent(d)).toBe(false);
  });

  it("objects and arrays pass through by reference, unmutated", () => {
    const obj = { a: 1, nested: { b: 2 } };
    const arr = [1, { c: 3 }];
    expect(sourceField({ x: obj }, "x").value).toBe(obj);
    expect(sourceField({ x: arr }, "x").value).toBe(arr);
    expect(obj).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("a non-object source is ABSENT rather than a thrown error", () => {
    for (const raw of [null, undefined, 7, "str", true]) {
      expect(isAbsent(sourceField(raw as never, "x"))).toBe(true);
    }
  });
});

describe("own-property law", () => {
  it("an inherited property is NOT source presence", () => {
    const proto = { x: 1 };
    const child = Object.create(proto);
    expect("x" in child).toBe(true); // the naive check would say present
    expect(isAbsent(sourceField(child, "x"))).toBe(true);
  });

  it("an own property shadowing an inherited one IS present", () => {
    const child = Object.create({ x: 1 });
    child.x = 2;
    expect(sourceField(child, "x")).toEqual({ kind: PRESENT, value: 2 });
  });

  it("a null-prototype object still reads correctly", () => {
    const raw = Object.create(null);
    raw.x = 5;
    expect(sourceField(raw, "x")).toEqual({ kind: PRESENT, value: 5 });
    expect(isAbsent(sourceField(raw, "y"))).toBe(true);
  });
});

describe("JSON durability", () => {
  it("ABSENT and PRESENT(null) survive a round-trip and stay distinguishable", () => {
    const a = roundTrip(sourceField({}, "x"));
    const p = roundTrip(sourceField({ x: null }, "x"));
    expect(a).toEqual({ kind: ABSENT });
    expect(p).toEqual({ kind: PRESENT, value: null });
    expect(a).not.toEqual(p);
    expect(isAbsent(a)).toBe(true);
    expect(isPresent(p)).toBe(true);
  });

  it("serialization is deterministic across repeated runs", () => {
    for (const d of [sourceField({}, "x"), sourceField({ x: null }, "x"), sourceField({ x: [1, 2] }, "x")]) {
      expect(JSON.stringify(d)).toBe(JSON.stringify(d));
      expect(JSON.stringify(roundTrip(d))).toBe(JSON.stringify(d));
    }
  });

  it("the DISCRIMINATOR survives even for values JSON cannot represent", () => {
    // This module promises the discriminator, not exact serialization of
    // arbitrary JavaScript. NaN/Infinity/-0/undefined all change or vanish
    // under JSON - and in every case the descriptor still reads PRESENT, so
    // absence is never manufactured. That is the load-bearing property.
    for (const v of [NaN, Infinity, -0, undefined, { a: undefined }]) {
      const rt = roundTrip(sourceField({ x: v }, "x"));
      expect(rt.kind).toBe(PRESENT);
      expect(isAbsent(rt)).toBe(false);
    }
  });

  it("exact preservation is an IN-MEMORY promise, not a JSON one", () => {
    // Stated plainly so nobody infers a durability guarantee that does not
    // exist. A predicate claiming otherwise was deleted for over-promising.
    expect(Object.is(sourceField({ x: NaN }, "x").value, NaN)).toBe(true);
    expect(Object.is(sourceField({ x: -0 }, "x").value, -0)).toBe(true);
    expect(JSON.parse(JSON.stringify({ v: NaN })).v).toBeNull();
    expect(Object.is(JSON.parse(JSON.stringify({ v: -0 })).v, -0)).toBe(false);
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/source-field.mjs"), "utf8");
    expect(src).not.toMatch(/isValueDurable|export\s+(const|function)\s+\w*[Dd]urable/);
  });
});

describe("why the retired representation was unsafe", () => {
  it("the old sentinel is truthy and non-null, so consumers misread it", () => {
    // Typed as a value a consumer would actually receive, so TypeScript does
    // not fold these away as constants.
    const sentinel: string | null = "UNKNOWN";
    expect(Boolean(sentinel)).toBe(true);
    expect(sentinel != null).toBe(true);
    expect(sentinel ?? "fallback").toBe("UNKNOWN");
  });

  it("the descriptor makes those patterns stop discriminating anything", () => {
    // Boolean() and != null are TRUE for absence and presence alike, so they no
    // longer silently pick a side - a consumer is forced to read `kind`.
    const a = sourceField({}, "x");
    const p = sourceField({ x: 1 }, "x");
    for (const d of [a, p]) {
      expect(Boolean(d)).toBe(true);
      expect(d != null).toBe(true);
    }
    expect(isAbsent(a)).not.toBe(isAbsent(p));
  });

  it("the primitive never asks a consumer to read absence as a field value", () => {
    // No unwrap/valueOr helper exists that would turn ABSENT into a default.
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/source-field.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(src).not.toMatch(/export\s+(function|const)\s+(valueOr|unwrap|getOr|orElse|coalesce)/);
    expect(src).not.toMatch(/\?\?/);
  });
});

describe("Foundation-A carries no semantic policy", () => {
  it("knows nothing about GitHub, authority, provenance or certainty", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/source-field.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const forbidden of [
      /AUTHORIZED/, /UNAUTHORIZED/, /PROVEN_/, /TRUSTED_FINDING/, /CLEAN/, /GREEN/,
      /in_reply_to_id/, /pull_request_review_id/, /Bot/, /codex/i, /github/i,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  it("BOUNDARY GUARD: no executable non-test source references it", () => {
    // The A/B split is safe only while this count is zero. Scanning one
    // directory would miss a nested module or a lib/ consumer, so this walks
    // every TRACKED implementation file instead.
    expect(findImporters(productionSources(), (f) => readFileSync(path.resolve(REPO, f), "utf8"))).toEqual([]);
  });

  it("the guard would CATCH an importer anywhere in production", () => {
    // Adversarial probes: the same matcher, over synthetic files it must flag.
    const probes: Record<string, string> = {
      "lib/example.ts": 'import { sourceField } from "../scripts/eng/source-field.mjs";',
      "nested/module/example.mjs": 'export * from "../../scripts/eng/source-field.mjs";',
      "app/(app)/x/actions.ts": 'const m = await import("@/scripts/eng/source-field.mjs");',
    };
    const caught = findImporters(Object.keys(probes), (f) => probes[f]);
    expect(caught.sort()).toEqual(Object.keys(probes).sort());
  });

  it("the guard scans a real, non-trivial set of files", () => {
    // Anti-vacuity: an empty or tiny file list would make the guard pass for
    // the wrong reason.
    const files = productionSources();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.startsWith("lib/"))).toBe(true);
    expect(files.some((f) => f.startsWith("scripts/eng/"))).toBe(true);
    expect(files.some((f) => f.startsWith("tests/"))).toBe(false);
  });
});
