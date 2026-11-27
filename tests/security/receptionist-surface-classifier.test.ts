import { describe, expect, it } from "vitest";
import { refused, shapeOf, vacuityPlan } from "../db/receptionist-callable-surface.classify";

// The classifier decides whether a call counted as a refusal. It must fail closed: a response that carries data next to a denial word is data.
const kind = (j: unknown) => shapeOf([{ j }], false);

describe("receptionist surface classifier", () => {
  it("accepts explicit denials", () => {
    expect(kind(null)).toBe("null");
    expect(kind(false)).toBe("false");
    expect(kind({ ok: false, code: "refused" })).toBe("json-ok-false");
    expect(kind("not_authorized")).toBe("status:not_authorized");
    expect(kind({ result: "not_authorized", appointment_id: null, starts_at: null })).toBe("status:not_authorized");
    expect(kind({ status: "no_invitation", choose_studio: false })).toBe("status:no_invitation");
    expect(refused({ kind: kind({ ok: false, code: "refused" }) })).toBe(true);
  });
  it("rejects a forged ok:false response that also leaks a record", () => {
    expect(kind({ ok: false, code: "refused", rows: [{ client_name: "Synthetic Person" }] })).toBe("data");
    expect(kind({ ok: false, code: "refused", record: { id: 1 } })).toBe("data");
    expect(kind({ ok: false, message: { nested: "x" } })).toBe("data");
    expect(refused({ kind: kind({ ok: false, code: "refused", rows: [{ a: 1 }] }) })).toBe(false);
  });
  it("rejects a status-word response that also leaks a value", () => {
    expect(kind({ result: "not_authorized", client_name: "Synthetic Person" })).toBe("data");
    expect(kind({ status: "refused", rows: ["x"] })).toBe("data");
    expect(kind({ status: "no_invitation", choose_studio: true })).toBe("data");
    expect(refused({ kind: kind({ result: "owner_only", amount: 5 }) })).toBe(false);
  });
  it("rejects free text, emails and ids in denial keys, and a truthy choose_studio", () => {
    expect(kind({ ok: false, message: "Jane Doe" })).toBe("data");
    expect(kind({ ok: false, code: "jane@example.com" })).toBe("data");
    expect(kind({ ok: false, choose_studio: "studio-id-123" })).toBe("data");
    expect(kind({ ok: false, code: "refused", choose_studio: true })).toBe("data");
    expect(kind({ ok: false, code: "jane_doe" })).toBe("data");
  });
  it("does not read a status word from an arbitrary key", () => {
    expect(kind({ client: "Jane", result: "not_authorized" })).toBe("data");
    expect(kind({ whatever: "not_authorized" })).toBe("data");
  });
  it("treats real data as data", () => {
    expect(kind({ id: "x", name: "y" })).toBe("data");
    expect(shapeOf([{ j: 1 }, { j: 2 }], false)).toBe("data");
  });
});

describe("vacuity plan", () => {
  it("fails an empty table that is not pinned", () => {
    expect(vacuityPlan(["a", "b"], ["a"], false).unpinnedEmpty).toEqual(["b"]);
  });
  it("never skips the static check for a pinned table, even when it is populated here", () => {
    const p = vacuityPlan(["a"], ["a", "c"], false);
    expect(p.staticTargets).toEqual(["a", "c"]);
    expect(p.populatedButPinned).toEqual(["c"]);
    expect(p.unpinnedEmpty).toEqual([]);
  });
  it("asserts the exact pin only on a fresh database", () => {
    expect(vacuityPlan(["a"], ["a", "c"], false).exactMismatch).toBe(false);
    expect(vacuityPlan(["a"], ["a", "c"], true).exactMismatch).toBe(true);
    expect(vacuityPlan(["a", "c"], ["a", "c"], true).exactMismatch).toBe(false);
  });
});
