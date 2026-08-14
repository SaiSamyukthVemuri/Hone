import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #255: Admin Console V1. Source-pins the operator console surface, the
// discoverable New Studio Wizard CTA, the cheap setup-health counts, and
// critically, that NO client-level clinical data is read into the console.
// Access control is the existing /admin layout isAdmin gate (pinned below);
// end-to-end behaviour is proven by e2e/new-studio-wizard.spec.ts.

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

const PAGE = read("app/admin/page.tsx");
const PAGE_CODE = codeOnly(PAGE);
const LAYOUT = read("app/admin/layout.tsx");

describe("operator-only access (reuses the /admin layout isAdmin gate)", () => {
  it("the admin layout still guards every /admin route", () => {
    expect(LAYOUT).toMatch(/if \(!user\) redirect\("\/login"\);/);
    expect(LAYOUT).toMatch(/if \(!isAdmin\(user\.email\)\) redirect\("\/dashboard"\);/);
  });

  it("the console reads via the service-role admin client (gated by the layout)", () => {
    expect(PAGE).toMatch(/from "@\/lib\/supabase\/admin-server"/);
    expect(PAGE_CODE).toMatch(/createAdminClient\(\)/);
  });

  it("exposes the New Studio Wizard from the admin nav", () => {
    expect(LAYOUT).toMatch(/href="\/admin\/studios\/new"/);
    expect(LAYOUT).toMatch(/New studio/);
  });
});

describe("Admin Console V1 surface", () => {
  it("renders the console header and a STATE-DRIVEN payment banner (PR B)", () => {
    expect(PAGE).toMatch(/Internal operator tools for invite-only studio setup\./);
    // The pre-live hardcoded payments-off note is gone; the banner reflects
    // the deployment's actual Stripe runtime + current-mode capability
    // counts, and a load error is never rendered as all-clear.
    expect(PAGE).not.toMatch(/Live payments are disabled\./);
    expect(PAGE).toMatch(/Stripe runtime:/);
    expect(PAGE).toMatch(/LIVE mode: real charges possible/);
    expect(PAGE).toMatch(/test mode: no real charges/);
    expect(PAGE).toMatch(/payouts pending/);
    expect(PAGE).toMatch(/not\s*\n?\s*connected/);
    expect(PAGE).toMatch(/summary could not be loaded/);
    expect(PAGE).toMatch(/loadPlatformPaymentSummary/);
  });

  it("has a Studio setup card linking to the New Studio Wizard", () => {
    expect(PAGE).toMatch(/Studio setup/);
    expect(PAGE).toMatch(/Create new studio/);
    expect(PAGE).toMatch(/href="\/admin\/studios\/new"/);
  });

  it("shows the overview counts (cheap, from existing tables)", () => {
    expect(PAGE).toMatch(/Pending owner invites/);
    expect(PAGE).toMatch(/Accepted owner invites/);
    expect(PAGE).toMatch(/Studios needing owner/);
    // Derived from the embedded aggregate counts + the owner-invitation query.
    expect(PAGE_CODE).toMatch(/\.eq\("role", "owner"\)/);
    expect(PAGE_CODE).toMatch(/practitioners\(count\)/);
    expect(PAGE_CODE).toMatch(/services\(count\)/);
    expect(PAGE_CODE).toMatch(/studio_availability_default\(count\)/);
  });

  it("renders the studios table with slug, timezone, invite status, and setup flags", () => {
    expect(PAGE).toMatch(/Owner invite/);
    expect(PAGE).toMatch(/Timezone/);
    expect(PAGE).toMatch(/\/book\/\$\{s\.slug\}/);
    expect(PAGE).toMatch(/label="Owner"/);
    expect(PAGE).toMatch(/label="Services"/);
    expect(PAGE).toMatch(/label="Availability"/);
  });
});

describe("data privacy: NO client-level clinical data in the console", () => {
  it("reads only aggregate counts + operational metadata (no client/clinical row reads)", () => {
    // Aggregate count embeds are allowed; selecting client/clinical ROWS is not.
    expect(PAGE_CODE).not.toMatch(/\.from\("clients"\)\s*\n?\s*\.select/);
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(sessions|session_blocks|treatment_areas|intake_submissions)"\)/,
    );
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(record_keeping_exposure_incidents|imported_treatment_memories|import_batches)"\)/,
    );
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(appointment_payments|payment_charge_attempts|manual_fee_charge_attempts|stripe_events|studio_payment_settings)"\)/,
    );
  });

  it("selects no treatment / exposure / payment / token / audit content columns", () => {
    expect(PAGE_CODE).not.toMatch(
      /treatment_area_text|tolerance_text|reaction_text|caution_note|exposed_person|probe_lot/i,
    );
    expect(PAGE_CODE).not.toMatch(/stripe_|payment_intent|client_secret|livemode/i);
    // No audit/token CONTENT is selected here. A nav link to /admin/audit is fine,
    // the audit log lives on its own isAdmin-gated page, not the console home.
    expect(PAGE_CODE).not.toMatch(/\btoken\b|audit_event|\.from\("[^"]*audit/i);
  });
});

describe("invite-only posture is not weakened", () => {
  it("introduces no public self-serve studio-creation route", () => {
    expect(existsSync(path.join(ROOT, "app/studios"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/signup"))).toBe(false);
    expect(existsSync(path.join(ROOT, "app/(auth)/signup"))).toBe(false);
    // The wizard stays operator-only under app/admin.
    expect(existsSync(path.join(ROOT, "app/admin/studios/new/page.tsx"))).toBe(true);
  });
});
