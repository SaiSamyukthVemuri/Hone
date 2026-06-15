import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #256: admin studio-detail privacy follow-up. Pins that the operator-only
// /admin/studios/[id] page shows operational metadata + AGGREGATE counts only,
// and no longer selects or renders raw client names/contacts or any clinical /
// payment / token / audit content. End-to-end (no seeded client name appears)
// is proven by e2e/new-studio-wizard.spec.ts.

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

const PAGE = read("app/admin/studios/[id]/page.tsx");
const PAGE_CODE = codeOnly(PAGE);
const LAYOUT = read("app/admin/layout.tsx");

describe("operator-only access (reuses the /admin layout isAdmin gate)", () => {
  it("the admin layout still guards every /admin route incl. studio detail", () => {
    expect(LAYOUT).toMatch(/if \(!user\) redirect\("\/login"\);/);
    expect(LAYOUT).toMatch(/if \(!isAdmin\(user\.email\)\) redirect\("\/dashboard"\);/);
  });

  it("reads via the service-role admin client (gated by the layout)", () => {
    expect(PAGE).toMatch(/from "@\/lib\/supabase\/admin-server"/);
    expect(PAGE_CODE).toMatch(/createAdminClient\(\)/);
  });
});

describe("privacy: no raw client data is selected or rendered", () => {
  it("does NOT run a standalone clients / practitioners / invitations ROW select", () => {
    // Clients/appointments/imported-memory appear ONLY as embedded (count)
    // aggregates inside the studios select, never as row queries.
    expect(PAGE_CODE).not.toMatch(/\.from\("clients"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("practitioners"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("imported_treatment_memories"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("appointments"\)/);
  });

  it("does NOT render a client name (the removed leak)", () => {
    expect(PAGE_CODE).not.toMatch(/clients\.map/);
    expect(PAGE_CODE).not.toMatch(/\{c\.name\}/);
    // The old leaky select shape must be gone.
    expect(PAGE_CODE).not.toMatch(/"id, name, created_at"/);
    expect(PAGE_CODE).not.toMatch(/\.from\("studios"\)\s*\n?\s*\.select\("\*"\)/);
  });

  it("selects NO clinical / payment / token / audit content columns", () => {
    expect(PAGE_CODE).not.toMatch(
      /treatment_area_text|tolerance_text|reaction_text|caution_note|exposed_person|probe_lot/i,
    );
    expect(PAGE_CODE).not.toMatch(/stripe_|payment_intent|client_secret|livemode/i);
    expect(PAGE_CODE).not.toMatch(/token|audit_event/i);
    // No client contact columns.
    expect(PAGE_CODE).not.toMatch(/phone|\baddress\b/i);
  });
});

describe("shows operational metadata + aggregate counts + setup flags", () => {
  it("uses embedded aggregate counts for the studio", () => {
    expect(PAGE_CODE).toMatch(/practitioners\(count\)/);
    expect(PAGE_CODE).toMatch(/clients\(count\)/);
    expect(PAGE_CODE).toMatch(/services\(count\)/);
    expect(PAGE_CODE).toMatch(/studio_availability_default\(count\)/);
    expect(PAGE_CODE).toMatch(/appointments\(count\)/);
    expect(PAGE_CODE).toMatch(/imported_treatment_memories\(count\)/);
  });

  it("renders metadata, counts, setup checks, and the disabled-payments flag", () => {
    expect(PAGE).toMatch(/Owner email/);
    expect(PAGE).toMatch(/Timezone/);
    expect(PAGE).toMatch(/Booking/);
    expect(PAGE).toMatch(/Owner invite/);
    expect(PAGE).toMatch(/Counts/);
    expect(PAGE).toMatch(/Setup checks/);
    expect(PAGE).toMatch(/Live payments disabled/);
    // Aggregate-only disclaimer.
    expect(PAGE).toMatch(/Aggregate counts only/);
  });

  it("links back to the console and the New Studio Wizard", () => {
    expect(PAGE).toMatch(/href="\/admin"/);
    expect(PAGE).toMatch(/href="\/admin\/studios\/new"/);
  });
});
