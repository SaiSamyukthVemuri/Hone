import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ABSENT, PRESENT, absent, isAbsent, isPresent, isValueDurable, present, sourceField } from "../../scripts/eng/source-field.mjs";

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

  it("PRESENT(undefined) loses its VALUE but never becomes ABSENT", () => {
    // JSON has no `undefined`, so this is the one lossy case. It is declared
    // rather than hidden, and the load-bearing property still holds: absence is
    // never manufactured from it. Only a hand-built object can produce it.
    const d = sourceField({ x: undefined }, "x");
    expect(isPresent(d)).toBe(true);
    expect(isValueDurable(d)).toBe(false);
    const rt = roundTrip(d);
    expect(rt.kind).toBe(PRESENT);
    expect(isAbsent(rt)).toBe(false);
    // Everything else IS durable.
    expect(isValueDurable(sourceField({ x: null }, "x"))).toBe(true);
    expect(isValueDurable(sourceField({}, "x"))).toBe(true);
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

  it("BOUNDARY GUARD: no production consumer imports it yet", () => {
    // This is what makes the A/B split safe - Foundation-A is inert until
    // Foundation-B migrates every consumer atomically.
    const dir = path.resolve(__dirname, "../../scripts/eng");
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs") && f !== "source-field.mjs")
      .filter((f) => /source-field/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(importers).toEqual([]);
  });
});
