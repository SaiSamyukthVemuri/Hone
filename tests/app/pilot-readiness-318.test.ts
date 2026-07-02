import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #318: supervised pilot readiness checklist + inspection-artifact fixes.
// Source/doc-pinned (RSC + markdown; no browser E2E harness).

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const BOOK = read("app/book/[slug]/PublicBookForm.tsx");
const CHECKLIST = read("docs/21_SUPERVISED_PILOT_CHECKLIST.md");

describe("returning-client booking copy no longer promises booking", () => {
  it("drops the misleading 'book follow-up sessions' copy", () => {
    expect(BOOK).not.toMatch(/book follow-up sessions/i);
    expect(BOOK).not.toMatch(/book follow up sessions/i);
  });
  it("uses accurate manage-only wording + a non-booking CTA to the portal", () => {
    expect(BOOK).toMatch(/manage your upcoming\s+appointments/i);
    // The existing-client card still routes to the portal, labelled as sign-in.
    expect(BOOK).toMatch(/portal\/login\?studio=/);
    expect(BOOK).toMatch(/Sign in to client portal/i);
  });
});

describe("supervised pilot checklist doc (docs/21)", () => {
  it("clearly states live payments remain disabled", () => {
    expect(CHECKLIST).toMatch(/Live payments remain DISABLED/i);
    expect(CHECKLIST).toMatch(/No card is ever charged|No card is charged/i);
  });
  it("includes the production verification step", () => {
    expect(CHECKLIST).toMatch(/verify-production\.mjs/);
    expect(CHECKLIST).toMatch(/migration.*max.*0100|0100/);
  });
  it("includes treatment-image bucket / private-policy verification", () => {
    expect(CHECKLIST).toMatch(/treatment-images/);
    expect(CHECKLIST).toMatch(/private/i);
    expect(CHECKLIST).toMatch(/storage\.objects/);
  });
  it("includes external reminder scheduler health", () => {
    expect(CHECKLIST).toMatch(/reminder scheduler/i);
    expect(CHECKLIST).toMatch(/cron-job\.org/);
    expect(CHECKLIST).toMatch(/CRON_SECRET/);
    expect(CHECKLIST).toMatch(/Healthy/);
  });
  it("includes a data-recovery subsection with PITR + RPO/RTO + who-can-restore + drill", () => {
    expect(CHECKLIST).toMatch(/Data recovery/i);
    expect(CHECKLIST).toMatch(/PITR|Point-In-Time Recovery/i);
    expect(CHECKLIST).toMatch(/plan tier/i);
    expect(CHECKLIST).toMatch(/RPO/);
    expect(CHECKLIST).toMatch(/RTO/);
    expect(CHECKLIST).toMatch(/[Ww]ho can restore/);
    expect(CHECKLIST).toMatch(/drill/i);
  });
  it("lists the must-configure items (services, consultation, availability, timezone, slug, email)", () => {
    for (const re of [
      /ACTIVE service/i,
      /CONSULTATION-type service/i,
      /Weekly availability/i,
      /studio timezone/i,
      /slug/i,
      /RESEND_API_KEY/,
    ]) {
      expect(CHECKLIST).toMatch(re);
    }
  });
  it("lists the intentionally-disabled items", () => {
    expect(CHECKLIST).toMatch(/Live payments/i);
    expect(CHECKLIST).toMatch(/deposit/i);
    expect(CHECKLIST).toMatch(/Returning-client online self-booking/i);
    expect(CHECKLIST).toMatch(/SMS/);
  });
});

describe("no schema / migration / stripe change in this PR's runtime edits", () => {
  it("the touched query/print/book files add no DDL or Stripe wiring", () => {
    for (const src of [
      read("lib/record-keeping/queries.ts"),
      read("app/(app)/records/print/page.tsx"),
      BOOK,
    ]) {
      expect(src).not.toMatch(/alter table|create table|create policy|drop policy/i);
      expect(src).not.toMatch(/STRIPE_ALLOW_LIVE_MODE|stripe\.checkout|createCheckoutSession/i);
    }
  });
});
