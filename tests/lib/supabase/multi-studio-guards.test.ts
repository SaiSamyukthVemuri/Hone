import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source pins for the multi-studio switcher (PR 2): cookie module, resolver,
// middleware and switch action. Behavior is exercised by
// practitioner-membership.test.ts; these lock the guard shape and the
// security invariants.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const COOKIE = read("lib/supabase/selected-studio.ts");
const QUERIES = read("lib/supabase/queries.ts");
const MW = read("lib/supabase/middleware.ts");
const ACTIONS = read("app/(auth)/no-access/actions.ts");

describe("selected-studio cookie is httpOnly + secure-in-prod + sameSite=lax", () => {
  it("sets a hardened cookie and offers read/set/clear", () => {
    expect(COOKIE).toMatch(/SELECTED_STUDIO_COOKIE = "hone_selected_studio"/);
    expect(COOKIE).toMatch(/httpOnly: true/);
    expect(COOKIE).toMatch(/secure: process\.env\.NODE_ENV === "production"/);
    expect(COOKIE).toMatch(/sameSite: "lax"/);
    expect(COOKIE).toMatch(/export async function readSelectedStudioId/);
    expect(COOKIE).toMatch(/export async function setSelectedStudioId/);
    expect(COOKIE).toMatch(/export async function clearSelectedStudioId/);
    expect(COOKIE).toMatch(/^import "server-only";/m);
  });
});

describe("resolver honors the cookie only against ACTIVE memberships", () => {
  it("selects by matching the cookie to a real active row; never auto-picks", () => {
    const idx = QUERIES.indexOf(
      "async function resolveActivePractitionerMembership",
    );
    expect(idx).toBeGreaterThan(-1);
    const body = QUERIES.slice(idx, idx + 900);
    expect(body).toMatch(/rows\.find\(\(r\) => r\.studio_id === selectedStudioId\)/);
    expect(body).toMatch(/kind: "selected"/);
    expect(body).toMatch(/kind: "choose"/);
    expect(body).not.toMatch(/maybeSingle/);
    // the membership query stays user-scoped + active-scoped (no RLS weakening)
    expect(QUERIES).toMatch(/\.eq\("user_id", userId\)/);
    expect(QUERIES).toMatch(/\.eq\("active", true\)/);
  });
  it("reads the selection via the cookie helper", () => {
    expect(QUERIES).toMatch(/readSelectedStudioId/);
  });
});

describe("middleware validates the cookie against the active studio set", () => {
  it("proceeds for exactly 1, or 2+ with a valid selection; else chooser", () => {
    expect(MW).toMatch(/activeStudioIds/);
    expect(MW).toMatch(/hasValidSelection/);
    expect(MW).toMatch(/activeStudioIds\.includes\(selectedStudioId\)/);
    expect(MW).toMatch(/set\("reason", "multiple-studios"\)/);
    const idx = MW.indexOf("const { data: memberships }");
    expect(MW.slice(idx, idx + 320)).not.toMatch(/maybeSingle/);
  });
  it("clears a stale/forged selection cookie on the redirect", () => {
    expect(MW).toMatch(/cookies\.delete\("hone_selected_studio"\)/);
  });
});

describe("switch action sets the cookie ONLY after verifying membership", () => {
  it("verifies active membership server-side, then sets the cookie, then /dashboard", () => {
    expect(ACTIONS).toMatch(/export async function switchStudioAction/);
    expect(ACTIONS).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(ACTIONS).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(ACTIONS).toMatch(/\.eq\("active", true\)/);
    // no membership -> never set the cookie; back to chooser
    expect(ACTIONS).toMatch(/if \(!membership\)/);
    expect(ACTIONS).toMatch(/setSelectedStudioId\(studioId/);
    expect(ACTIONS).toMatch(/redirect\("\/dashboard"\)/);
    // the setSelectedStudioId call comes AFTER the membership guard
    expect(ACTIONS.indexOf("if (!membership)")).toBeLessThan(
      ACTIONS.indexOf("setSelectedStudioId(studioId"),
    );
  });
});
