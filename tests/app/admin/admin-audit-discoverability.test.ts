import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Admin audit log discoverability (admin UI/nav only). Surfaces the existing
// /admin/audit page (PR #374) from the admin dashboard. No audit schema/logging
// change; no exposure to normal practitioner navigation.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const ADMIN_HOME = read("app/admin/page.tsx");
const AUDIT_PAGE = read("app/admin/audit/page.tsx");
const ADMIN_LAYOUT = read("app/admin/layout.tsx");
const APP_LAYOUT = read("app/(app)/layout.tsx");

describe("admin dashboard exposes the audit log", () => {
  it("renders an Admin audit log card linking to /admin/audit", () => {
    expect(ADMIN_HOME).toMatch(/<AuditLogCard \/>/);
    expect(ADMIN_HOME).toMatch(/function AuditLogCard\(/);
    expect(ADMIN_HOME).toMatch(/href="\/admin\/audit"/);
  });
  it("uses the 'Admin audit log' label", () => {
    expect(ADMIN_HOME).toMatch(/Admin audit log/);
  });
  it("shows the description copy", () => {
    expect(ADMIN_HOME).toMatch(
      /Review sensitive operator\/admin actions such as studio creation, ops\s*\n?\s*alert resolution, and demo follow-up/,
    );
  });
});

describe("scoped to the admin area; audit page stays admin-gated", () => {
  it("the practitioner (non-admin) app nav does NOT expose /admin/audit", () => {
    expect(APP_LAYOUT).not.toMatch(/\/admin\/audit/);
  });
  it("the /admin/audit page remains isAdmin-gated (unchanged)", () => {
    expect(AUDIT_PAGE).toMatch(/isAdmin\(user\.email\)/);
    expect(AUDIT_PAGE).toMatch(/redirect\("\/no-access"\)/);
  });
  it("the /admin layout still gates every admin route on isAdmin (unchanged)", () => {
    expect(ADMIN_LAYOUT).toMatch(/isAdmin\(user\.email\)/);
  });
});

describe("no audit schema / logging / behavior change", () => {
  it("the dashboard card is a plain link, no audit-logging or data mutation", () => {
    expect(ADMIN_HOME).not.toMatch(/logAdminAction|admin_action_events/);
    // no payment/email/SMS surface introduced by this change
    expect(ADMIN_HOME).not.toMatch(/sendEmail|twilio|sendSms/i);
  });
});
