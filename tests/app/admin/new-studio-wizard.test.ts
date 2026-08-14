import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #254: internal New Studio Wizard. Source-pins the operator-only access,
// the two service-role writes (studios + owner pending_invitation), and the
// invariants that must not regress: NO direct practitioner insert, NO
// payment/Stripe surface, and the PR #253 invite-only gate stays closed for
// non-operators. End-to-end behaviour is proven by
// tests/db/new-studio-wizard.db.test.ts and e2e/new-studio-wizard.spec.ts.

const ROOT = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const ACTION = read("app/admin/studios/new/actions.ts");
const ACTION_CODE = codeOnly(ACTION);
const PAGE = read("app/admin/studios/new/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");
const MIDDLEWARE = read("lib/supabase/middleware.ts");

describe("operator-only access (reuses the existing isAdmin gate)", () => {
  it("the admin layout guards every /admin route (so the wizard inherits it)", () => {
    expect(LAYOUT).toMatch(/if \(!user\) redirect\("\/login"\);/);
    expect(LAYOUT).toMatch(/if \(!isAdmin\(user\.email\)\) redirect\("\/dashboard"\);/);
  });

  it("the create action re-checks isAdmin server-side BEFORE any write", () => {
    expect(ACTION_CODE).toMatch(/if \(!user \|\| !isAdmin\(user\.email\)\)/);
    expect(ACTION_CODE).toMatch(/throw new Error\("Not authorized\."\)/);
    // The isAdmin check must come before the service-role client is created.
    const gateIdx = ACTION_CODE.indexOf("isAdmin(user.email)");
    const adminIdx = ACTION_CODE.indexOf("createAdminClient()");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(gateIdx);
  });

  it("reuses isAdmin from @/lib/admin: no new operator allowlist is introduced", () => {
    expect(ACTION).toMatch(/from "@\/lib\/admin"/);
    expect(ACTION).not.toMatch(/HONE_OPERATOR_EMAILS|OPERATOR_EMAILS/);
  });
});

describe("the two service-role writes mirror the manual runbook", () => {
  it("uses the service-role admin client for the privileged inserts", () => {
    expect(ACTION).toMatch(/from "@\/lib\/supabase\/admin-server"/);
    expect(ACTION_CODE).toMatch(/createAdminClient\(\)/);
  });

  it("inserts a studio (name, owner_email, slug, timezone)", () => {
    expect(ACTION_CODE).toMatch(/\.from\("studios"\)\s*\n?\s*\.insert\(/);
    expect(ACTION_CODE).toMatch(/owner_email:/);
    expect(ACTION_CODE).toMatch(/slug:/);
    expect(ACTION_CODE).toMatch(/timezone:/);
  });

  it("inserts an owner pending_invitation", () => {
    expect(ACTION_CODE).toMatch(/\.from\("pending_invitations"\)\s*\n?\s*\.insert\(/);
    expect(ACTION_CODE).toMatch(/role: "owner"/);
  });

  it("NEVER inserts a practitioners row directly (owner is created by the trigger)", () => {
    expect(ACTION_CODE).not.toMatch(/\.from\("practitioners"\)/);
  });

  it("compensating-deletes the studio if the invitation insert fails (no orphan)", () => {
    expect(ACTION_CODE).toMatch(/if \(inviteErr\)/);
    expect(ACTION_CODE).toMatch(/\.from\("studios"\)\s*\n?\s*\.delete\(\)/);
  });

  it("touches NO payment / Stripe / fee / livemode columns", () => {
    expect(ACTION_CODE).not.toMatch(
      /fee_cents|stripe|livemode|payment|paymentIntents|require_card/i,
    );
  });
});

describe("the wizard page is a safe internal surface", () => {
  it("is titled and subtitled for internal setup only, and is noindex", () => {
    expect(PAGE).toMatch(/New studio/);
    expect(PAGE).toMatch(/Create a studio and owner invitation\. Internal setup only\./);
    expect(PAGE).toMatch(/index: false/);
  });

  it("renders the required fields", () => {
    expect(PAGE).toMatch(/name="name"/);
    expect(PAGE).toMatch(/name="slug"/);
    expect(PAGE).toMatch(/name="owner_display_name"/);
    expect(PAGE).toMatch(/name="owner_email"/);
    expect(PAGE).toMatch(/name="timezone"/);
  });

  it("success state shows the booking URL and the setup checklist incl. live payments disabled", () => {
    expect(PAGE).toMatch(/\/book\/\$\{studio\.slug\}/);
    expect(PAGE).toMatch(/Next setup steps/);
    // PR B: accurate onboarding copy, payments are per-studio, not
    // globally disabled.
    expect(PAGE).not.toMatch(/Live payments remain disabled/);
    expect(PAGE).toMatch(/Payments are not connected until the studio completes Stripe/);
  });
});

describe("PR #253 invite-only gate stays closed for non-operators", () => {
  it("middleware exempts /admin ONLY for isAdmin operators, still gating others to /no-access", () => {
    expect(MIDDLEWARE).toMatch(/from "@\/lib\/admin"/);
    expect(MIDDLEWARE).toMatch(/isAdminRoute/);
    expect(MIDDLEWARE).toMatch(/isAdminRoute && isAdmin\(user\.email\)/);
    // The no-studio -> /no-access redirect is still present for everyone else.
    expect(MIDDLEWARE).toMatch(/url\.pathname = "\/no-access"/);
    expect(MIDDLEWARE).toMatch(/\.from\("practitioners"\)/);
  });

  it("introduces NO public self-serve studio-creation route", () => {
    // The wizard lives ONLY under app/admin (operator-gated). No public route.
    expect(existsSync(path.join(ROOT, "app/studios"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/(auth)/signup"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/signup"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/admin/studios/new/page.tsx"))).toBe(true);
  });
});
