import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Privacy C1 (#1300): the OPS ruling is NO practitioner financial signal. For a non-owner the consent
// loaders must not READ card-authorization templates or signatures at all. This fake applies the
// loaders' own filters to in-memory rows, so the assertions are about what comes back, not call shapes.
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const TEMPLATES: Row[] = [
  { id: "t-photo", studio_id: "s1", form_type: "photo_consent", status: "active", title: "Photo", is_live: true, version: 1 },
  { id: "t-card", studio_id: "s1", form_type: "card_authorization", status: "active", title: "Card authorization", is_live: true, version: 2 },
];
const SIGNATURES: Row[] = [
  { id: "g1", studio_id: "s1", client_id: "c1", template_id: "t-photo", signed_at: "2026-10-01T00:00:00Z" },
  { id: "g2", studio_id: "s1", client_id: "c1", template_id: "t-card", signed_at: "2026-10-02T00:00:00Z" },
];
const reads: { table: string; filters: string[] }[] = [];

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const entry = { table, filters: [] as string[] };
      reads.push(entry);
      let rows = table === "consent_form_templates" ? [...TEMPLATES] : [...SIGNATURES];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, val: unknown) => { entry.filters.push(`eq:${col}`); rows = rows.filter((r) => r[col] === val); return q; },
        neq: (col: string, val: unknown) => { entry.filters.push(`neq:${col}`); rows = rows.filter((r) => r[col] !== val); return q; },
        not: (col: string, _op: string, list: string) => {
          entry.filters.push(`not:${col}`);
          const ids = list.replace(/[()]/g, "").split(",");
          rows = rows.filter((r) => !ids.includes(String(r[col])));
          return q;
        },
        order: () => q,
        then: (res: (v: unknown) => void) => res({ data: rows, error: null }),
      };
      return q;
    },
  }),
}));

describe("consent loaders: card authorization is excluded at the query for a non-owner", () => {
  it("templates: includeCardAuthorization:false never returns the card template", async () => {
    const { getConsentTemplatesForStudio } = await import("@/lib/consent/queries");
    reads.length = 0;
    const out = await getConsentTemplatesForStudio("s1", { includeCardAuthorization: false });
    expect(out.map((t) => t.id)).toEqual(["t-photo"]);
    expect(reads[0].filters).toContain("neq:form_type");
  });

  it("signatures: a card-authorization signature row is never returned or selected", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    reads.length = 0;
    const out = await getLatestSignaturesForPractitionerView("s1", "c1", { includeCardAuthorization: false });
    expect(out.map((s) => s.template_id)).toEqual(["t-photo"]);
    const signatureRead = reads.find((r) => r.table === "client_consent_signatures");
    expect(signatureRead?.filters).toContain("not:template_id");
  });

  it("the owner path (and every other caller) is unchanged", async () => {
    const { getConsentTemplatesForStudio, getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    reads.length = 0;
    expect((await getConsentTemplatesForStudio("s1")).map((t) => t.id).sort()).toEqual(["t-card", "t-photo"]);
    expect((await getConsentTemplatesForStudio("s1", { includeCardAuthorization: true })).length).toBe(2);
    expect((await getLatestSignaturesForPractitionerView("s1", "c1")).length).toBe(2);
    expect(reads.some((r) => r.filters.includes("neq:form_type") || r.filters.includes("not:template_id"))).toBe(false);
  });
});

describe("the profile page asks for the scope per viewer, and card authorization stays in Billing", () => {
  const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  it("both consent reads pass includeCardAuthorization: isOwner", () => {
    expect(page).toMatch(/getConsentTemplatesForStudio\(studio\.id, \{ includeCardAuthorization: isOwner \}\)/);
    expect(page).toMatch(/getLatestSignaturesForPractitionerView\(studio\.id, client\.id, \{ includeCardAuthorization: isOwner \}\)/);
  });
  it("the card-authorization derivation lives only inside the owner Billing block", () => {
    const at = page.indexOf('t.form_type === "card_authorization"');
    expect(at).toBeGreaterThan(-1);
    const billing = page.lastIndexOf('activeTab === "billing" && isOwner', at);
    expect(billing).toBeGreaterThan(-1);
    expect(page.indexOf('t.form_type === "card_authorization"', at + 1)).toBe(-1);
  });
});
