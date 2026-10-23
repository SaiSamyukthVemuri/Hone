import { describe, expect, it } from "vitest";
import { safeAdminReturnPath, safeInternalPath } from "@/lib/auth/return-path";

// LEAD-ALERT-01 (Codex P2 4248920454): the only return targets sign-in may
// honour. Every value here is attacker-influenced (a query string or a cookie).

const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

describe("safeInternalPath", () => {
  it("keeps a same-origin relative path and its query, never a fragment", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/admin/leads/demo-request/abc?x=1")).toBe("/admin/leads/demo-request/abc?x=1");
    expect(safeInternalPath("/admin#lead-x")).toBe("/admin");
  });

  it.each([
    ["absolute URL", "https://evil.example/admin"],
    ["scheme", "javascript:alert(1)"],
    ["protocol-relative", "//evil.example/admin"],
    ["backslash host", "/\\evil.example"],
    ["userinfo", "@evil.example"],
    ["userinfo after slash", "/@evil.example"],
    ["host suffix", ".evil.example"],
    ["tab-smuggled slashes", `/${TAB}/evil.example`],
    ["newline", `/admin${NL}x`],
    ["NUL", `/admin${NUL}`],
    ["space", "/admin x"],
    ["empty", ""],
    ["over-long", `/${"a".repeat(600)}`],
    ["not a string", 42],
    ["null", null],
  ])("refuses %s", (_label, raw) => {
    expect(safeInternalPath(raw)).toBeNull();
  });
});

describe("safeAdminReturnPath", () => {
  it("accepts /admin and paths under it only", () => {
    expect(safeAdminReturnPath("/admin")).toBe("/admin");
    expect(safeAdminReturnPath("/admin/leads/early-access/abc")).toBe("/admin/leads/early-access/abc");
    expect(safeAdminReturnPath("/admin?leadAlertsFailedPage=2")).toBe("/admin?leadAlertsFailedPage=2");
  });

  it("refuses an internal path outside /admin, a lookalike prefix and every unsafe value", () => {
    // "/admin/../dashboard" is normalised by the parser before the check:
    // what is checked is what a browser would load.
    for (const raw of ["/dashboard", "/administrator", "/admins/x", "/admin.evil", "//admin", "https://hone.example/admin", "/admin/../dashboard"]) {
      expect(safeAdminReturnPath(raw), raw).toBeNull();
    }
  });
});
