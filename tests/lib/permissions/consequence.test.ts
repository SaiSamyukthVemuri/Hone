import { describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";
import { consequenceClass, DESTRUCTIVE_KEYS } from "@/lib/permissions/consequence";

const DEFS = CATALOG as readonly PermissionDef[];

describe("consequence class", () => {
  it("every reviewed destructive key exists in the catalog", () => {
    for (const k of DESTRUCTIVE_KEYS) expect(DEFS.some((d) => d.key === k), k).toBe(true);
  });
  it("destructive outranks financial outranks sensitive, and a plain key has none", () => {
    expect(consequenceClass({ key: "pay.void", group: "payments", sensitive: true })).toBe("destructive");
    expect(consequenceClass({ key: "pay.view_totals", group: "payments", sensitive: true })).toBe("financial");
    expect(consequenceClass({ key: "x", group: "clients_identity", sensitive: true })).toBe("sensitive");
    expect(consequenceClass({ key: "x", group: "clients_identity" })).toBeNull();
  });
  it("every sensitive key carries a class, so the page never has to guess when a reason is needed", () => {
    for (const d of DEFS.filter((x) => x.sensitive)) expect(consequenceClass(d), d.key).not.toBeNull();
  });
});
