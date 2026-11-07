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
  // A card template a member flipped to "general" through the Data API (Privacy V-3), an unknown
  // future form type, and a template in another studio.
  { id: "t-flipped", studio_id: "s1", form_type: "general", status: "archived", title: "Card authorization (old)", is_live: false, version: 1 },
  { id: "t-future", studio_id: "s1", form_type: "something_new", status: "active", title: "Future", is_live: true, version: 1 },
  { id: "t-other", studio_id: "s2", form_type: "card_authorization", status: "active", title: "Other studio card", is_live: true, version: 1 },
];
const CARDS: Row[] = [
  // The card on file points at the signature that authorized it, whatever its template is called now.
  { studio_id: "s1", client_id: "c1", card_authorization_signature_id: "g3" },
];
const SIGNATURES: Row[] = [
  { id: "g1", studio_id: "s1", client_id: "c1", template_id: "t-photo", signed_at: "2026-10-01T00:00:00Z" },
  { id: "g2", studio_id: "s1", client_id: "c1", template_id: "t-card", signed_at: "2026-10-02T00:00:00Z" },
  { id: "g3", studio_id: "s1", client_id: "c1", template_id: "t-flipped", signed_at: "2026-10-03T00:00:00Z" },
  { id: "g4", studio_id: "s1", client_id: "c1", template_id: "t-future", signed_at: "2026-10-04T00:00:00Z" },
  { id: "g5", studio_id: "s1", client_id: "c1", template_id: "t-deleted", signed_at: "2026-10-05T00:00:00Z" },
];
const reads: { table: string; filters: string[] }[] = [];

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const entry = { table, filters: [] as string[] };
      reads.push(entry);
      let rows =
        table === "consent_form_templates" ? [...TEMPLATES]
        : table === "client_payment_methods" ? [...CARDS]
        : [...SIGNATURES];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, val: unknown) => { entry.filters.push(`eq:${col}`); rows = rows.filter((r) => r[col] === val); return q; },
        neq: (col: string, val: unknown) => { entry.filters.push(`neq:${col}`); rows = rows.filter((r) => r[col] !== val); return q; },
        not: (col: string, op: string, list: string) => {
          entry.filters.push(`not:${col}`);
          if (op === "is") { rows = rows.filter((r) => r[col] != null); return q; }
          const ids = list.replace(/[()]/g, "").split(",");
          rows = rows.filter((r) => !ids.includes(String(r[col])));
          return q;
        },
        in: (col: string, list: unknown[]) => { entry.filters.push(`in:${col}`); rows = rows.filter((r) => list.includes(r[col])); return q; },
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
    expect(out.map((t) => t.id).sort()).toEqual(["t-flipped", "t-photo"]);
    expect(reads[0].filters).toContain("in:form_type");
  });

  it("signatures: a card-authorization signature row is never returned or selected", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    reads.length = 0;
    const out = await getLatestSignaturesForPractitionerView("s1", "c1", { includeCardAuthorization: false });
    expect(out.map((s) => s.template_id)).toEqual(["t-photo"]);
    const signatureRead = reads.find((r) => r.table === "client_consent_signatures");
    expect(signatureRead?.filters).toContain("in:template_id");
  });

  it("signatures: classified by what was signed, and fail closed", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    const out = await getLatestSignaturesForPractitionerView("s1", "c1", { includeCardAuthorization: false });
    const ids = out.map((s) => s.id);
    expect(ids).not.toContain("g3"); // template flipped to "general", but the card on file points at it
    expect(ids).not.toContain("g4"); // unknown form type
    expect(ids).not.toContain("g5"); // template gone
    expect(ids).not.toContain("g2");
    expect(ids).toEqual(["g1"]);
  });

  it("another studio's owner asking for studio s2 never sees studio s1 signatures", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    expect(await getLatestSignaturesForPractitionerView("s2", "c1", { includeCardAuthorization: false })).toEqual([]);
    expect((await getLatestSignaturesForPractitionerView("s2", "c1", { includeCardAuthorization: true })).length).toBe(0);
  });

  it("the owner path (and every other caller) is unchanged", async () => {
    const { getConsentTemplatesForStudio, getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    reads.length = 0;
    expect((await getConsentTemplatesForStudio("s1", { includeCardAuthorization: true })).map((t) => t.id).sort()).toEqual(["t-card", "t-flipped", "t-future", "t-photo"]);
    expect((await getConsentTemplatesForStudio("s1", { includeCardAuthorization: true })).length).toBe(4);
    expect((await getLatestSignaturesForPractitionerView("s1", "c1", { includeCardAuthorization: true })).length).toBe(5);
    expect(reads.some((r) => r.filters.includes("in:form_type") || r.filters.includes("in:template_id"))).toBe(false);
  });
});

describe("only an active owner reaches the card-authorization read", () => {
  it.each(["practitioner", "receptionist", "admin", "", null, undefined])("role %j is not an owner", async (role) => {
    const { canViewClientBilling } = await import("@/lib/clients/profile-tabs");
    expect(canViewClientBilling(role as string | null | undefined)).toBe(false);
  });
  it("the owner is", async () => {
    const { canViewClientBilling } = await import("@/lib/clients/profile-tabs");
    expect(canViewClientBilling("owner")).toBe(true);
  });
  it("the page resolves the viewer from an ACTIVE practitioner row in the session's studio", () => {
    const q = readFileSync("lib/supabase/queries.ts", "utf8");
    expect(q).toMatch(/\.eq\("active", true\)/);
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

describe("an undefined scope at runtime fails closed (Privacy H-1)", () => {
  it.each([undefined, null, "yes", 1])("includeCardAuthorization %j hides card authorization", async (v) => {
    const { getConsentTemplatesForStudio, getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    const scope = { includeCardAuthorization: v } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await getConsentTemplatesForStudio("s1", scope)).map((t) => t.id)).not.toContain("t-card");
    const ids = (await getLatestSignaturesForPractitionerView("s1", "c1", scope)).map((s) => s.id);
    expect(ids).toEqual(["g1"]);
  });
  it("a missing scope object entirely also hides it", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    const ids = (await getLatestSignaturesForPractitionerView("s1", "c1", {} as any)).map((s) => s.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ids).toEqual(["g1"]);
  });
});

describe("no caller can read card authorization by omission", () => {
  it("every call to the two loaders names includeCardAuthorization", async () => {
    const { execSync } = await import("node:child_process");
    const files = execSync(
      "grep -rlE 'getConsentTemplatesForStudio|getLatestSignaturesForPractitionerView' app lib components --include=*.ts --include=*.tsx",
      { encoding: "utf8" },
    ).split("\n").filter((f) => f && f !== "lib/consent/queries.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const calls = src.match(/(getConsentTemplatesForStudio|getLatestSignaturesForPractitionerView)\([^)]*\)/g) ?? [];
      for (const c of calls) expect(c, `${f}: ${c}`).toMatch(/includeCardAuthorization/);
    }
  });
});
