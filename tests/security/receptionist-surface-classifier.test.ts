import { describe, expect, it } from "vitest";
import { refused, shapeOf } from "../db/receptionist-callable-surface.classify";

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
  it("treats real data as data", () => {
    expect(kind({ id: "x", name: "y" })).toBe("data");
    expect(shapeOf([{ j: 1 }, { j: 2 }], false)).toBe("data");
  });
});
