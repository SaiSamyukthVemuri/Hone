import { describe, expect, it } from "vitest";
import {
  STRIPE_ERROR_TYPES,
  THROWN_ERROR_CLASSES,
  dbErrorCode,
  safeDbCode,
  stripeErrorFields,
  thrownErrorClass,
} from "@/lib/logging/error-class";

// MSG-LOG-RAW-ERROR-2. The classes a log line may carry INSTEAD of an error's
// text. Every hostile string below stands for what real errors quote: a value
// from a constraint, a destination address, a URL, a token, a record id.
const HOSTILE =
  "duplicate key value violates unique constraint: Key (email)=(synthetic.person@example.test) " +
  "phone +1 604 555 0184 https://example.test/portal?token=abc123 " +
  "5b0f7a52-3c1d-4c8e-9a52-0b3f6a1d2e44";

function leaks(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /synthetic\.person|example\.test|604 555|abc123|5b0f7a52|duplicate key/i.test(text);
}

describe("dbErrorCode: a database error becomes its SQLSTATE or PostgREST code, nothing else", () => {
  it.each([
    ["a unique violation", "23505"],
    ["a check violation", "23514"],
    ["an undefined table", "42P01"],
    ["a lock timeout", "55P03"],
    ["an insufficient privilege", "42501"],
    ["a PostgREST not-found", "PGRST116"],
    ["a PostgREST schema-cache miss", "PGRST202"],
  ])("%s keeps its code %s", (_name, code) => {
    expect(dbErrorCode({ code, message: HOSTILE, details: HOSTILE, hint: HOSTILE })).toBe(code);
    expect(leaks(dbErrorCode({ code, message: HOSTILE }))).toBe(false);
  });

  it.each([
    ["a missing code", {}],
    ["a null code", { code: null }],
    ["a numeric code", { code: 23505 }],
    ["a code that is free text", { code: HOSTILE }],
    ["a code carrying an email", { code: "synthetic.person@example.test" }],
    ["a lowercase code", { code: "pgrst116" }],
    ["a code with a trailing space", { code: "23505 " }],
    ["a six-character code", { code: "235055" }],
    ["a PostgREST code with extra text", { code: "PGRST116 detail" }],
  ])("%s becomes 'unknown'", (_name, error) => {
    expect(dbErrorCode(error)).toBe("unknown");
  });

  it("never reads the message, and tolerates null, undefined and non-objects", () => {
    expect(dbErrorCode(null)).toBe("unknown");
    expect(dbErrorCode(undefined)).toBe("unknown");
    expect(dbErrorCode("23505")).toBe("unknown");
    expect(dbErrorCode(new Error(HOSTILE))).toBe("unknown");
  });

  it("safeDbCode applies the same rule to a code that was already pulled off an error", () => {
    expect(safeDbCode("42501")).toBe("42501");
    expect(safeDbCode(HOSTILE)).toBe("unknown");
    expect(safeDbCode(undefined)).toBe("unknown");
  });
});

describe("thrownErrorClass: a thrown value becomes one of a closed list, never its text", () => {
  it("abort and timeout, by name", () => {
    expect(thrownErrorClass(Object.assign(new Error(HOSTILE), { name: "AbortError" }))).toBe("abort");
    expect(thrownErrorClass(Object.assign(new Error(HOSTILE), { name: "TimeoutError" }))).toBe("timeout");
    expect(thrownErrorClass(new DOMException(HOSTILE, "AbortError"))).toBe("abort");
  });

  it.each([
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
    ["ECONNRESET", "network"],
    ["ECONNREFUSED", "network"],
    ["ENOTFOUND", "network"],
    ["EAI_AGAIN", "network"],
    ["UND_ERR_SOCKET", "network"],
  ])("a system code %s on the error is %s", (code, expected) => {
    expect(thrownErrorClass(Object.assign(new Error(HOSTILE), { code }))).toBe(expected);
  });

  it("the same codes are found on a cause (how undici wraps them)", () => {
    expect(thrownErrorClass(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe("network");
    expect(thrownErrorClass(new TypeError(HOSTILE, { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }))).toBe("timeout");
  });

  it("a bare 'fetch failed' TypeError is a network failure; any other TypeError is not", () => {
    expect(thrownErrorClass(new TypeError("fetch failed"))).toBe("network");
    expect(thrownErrorClass(new TypeError(HOSTILE))).toBe("type_error");
    expect(thrownErrorClass(new TypeError("fetch failed: " + HOSTILE))).toBe("type_error");
  });

  it("range, syntax and plain errors", () => {
    expect(thrownErrorClass(new RangeError(HOSTILE))).toBe("range_error");
    expect(thrownErrorClass(new SyntaxError(HOSTILE))).toBe("syntax_error");
    expect(thrownErrorClass(new Error(HOSTILE))).toBe("error");
    expect(thrownErrorClass(Object.assign(new Error(HOSTILE), { code: HOSTILE }))).toBe("error");
  });

  it("a thrown string, number, null or plain object is 'non_error' (it is exactly what carries data)", () => {
    expect(thrownErrorClass(HOSTILE)).toBe("non_error");
    expect(thrownErrorClass(404)).toBe("non_error");
    expect(thrownErrorClass(null)).toBe("non_error");
    expect(thrownErrorClass(undefined)).toBe("non_error");
    expect(thrownErrorClass({ message: HOSTILE, detail: HOSTILE })).toBe("non_error");
  });

  it("an error-like object with a string name is classified by shape, not by its text", () => {
    expect(thrownErrorClass({ name: "Whatever", message: HOSTILE })).toBe("error");
  });

  it("the result is always a member of the closed list and never contains the input", () => {
    const inputs: unknown[] = [
      new Error(HOSTILE),
      new TypeError(HOSTILE),
      Object.assign(new Error(HOSTILE), { name: HOSTILE }),
      Object.assign(new Error(HOSTILE), { code: HOSTILE, cause: { code: HOSTILE } }),
      HOSTILE,
      { toString: () => HOSTILE },
    ];
    for (const input of inputs) {
      const cls = thrownErrorClass(input);
      expect(THROWN_ERROR_CLASSES).toContain(cls);
      expect(leaks(cls)).toBe(false);
    }
  });
});

describe("stripeErrorFields: only the documented type and a machine code, never Stripe's text", () => {
  it.each(STRIPE_ERROR_TYPES)("keeps the type %s and a well-formed code", (type) => {
    const fields = stripeErrorFields({ type, code: "card_declined", message: HOSTILE, raw: { message: HOSTILE }, param: HOSTILE, decline_code: HOSTILE });
    expect(fields).toEqual({ stripeType: type, stripeCode: "card_declined" });
    expect(leaks(fields)).toBe(false);
  });

  it("drops a type that is not a documented Stripe type, and the code with it", () => {
    expect(stripeErrorFields({ type: HOSTILE, code: "card_declined" })).toEqual({});
    expect(stripeErrorFields({ type: "SomethingElse", code: "card_declined" })).toEqual({});
  });

  it.each([
    ["free text", HOSTILE],
    ["an email", "synthetic.person@example.test"],
    ["uppercase", "CARD_DECLINED"],
    ["digits only", "6045550184"],
    ["a trailing space", "card_declined "],
    ["a single character", "c"],
    ["a number", 402],
  ])("drops a code that is %s but keeps the type", (_name, code) => {
    expect(stripeErrorFields({ type: "StripeCardError", code })).toEqual({ stripeType: "StripeCardError" });
  });

  it("tolerates anything that is not an object", () => {
    expect(stripeErrorFields(null)).toEqual({});
    expect(stripeErrorFields(undefined)).toEqual({});
    expect(stripeErrorFields(HOSTILE)).toEqual({});
    expect(stripeErrorFields(new Error(HOSTILE))).toEqual({});
  });
});
