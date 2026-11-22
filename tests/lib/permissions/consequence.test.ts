import { describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";
import { consequenceClass } from "@/lib/permissions/consequence";

const DEFS = CATALOG as readonly PermissionDef[];
const cls = (k: string) => consequenceClass(DEFS.find((d) => d.key === k)!);

describe("consequence class", () => {
  it("no delegable key is classed destructive: that label belongs to the fixed owner-only deletion, archive and restore controls", () => {
    for (const d of DEFS) expect(consequenceClass(d), d.key).not.toBe("destructive");
  });
  it("cancelling is ordinary; voiding and refunding are financial", () => {
    expect(cls("appt.cancel")).toBeNull();
    expect(cls("pay.void")).toBe("financial");
    expect(cls("pay.refund")).toBe("financial");
  });
  it("financial outranks sensitive, and a plain key has none", () => {
    expect(consequenceClass({ key: "x", group: "payments", sensitive: true })).toBe("financial");
    expect(consequenceClass({ key: "x", group: "clients_identity", sensitive: true })).toBe("sensitive");
    expect(consequenceClass({ key: "x", group: "clients_identity" })).toBeNull();
  });
  it("every sensitive key carries a class, so the page never has to guess when a reason is needed", () => {
    for (const d of DEFS.filter((x) => x.sensitive)) expect(consequenceClass(d), d.key).not.toBeNull();
  });
});
