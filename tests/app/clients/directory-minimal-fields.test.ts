import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// DAT-001 minimal returned fields. The directory page hands its components only
// the projected row fields (display name, pronouns, email, phone, archived-at, id,
// plus the next appointment and intake STATE), never a whole clients row: every
// other column is a sentinel here and must never reach a component's props. The
// directory read's own column list is pinned in
// tests/lib/clients/directory-guards.test.ts.

// A full clients row as the database holds it. Every value the list does not
// render is a sentinel that must never reach the client component.
const FULL_ROW = {
  id: "c1", studio_id: "studio-1", name: "Visible Name", pronouns: "they/them",
  phone: "+1 555 0100", email: "visible@example.test", address: "SENTINEL-address",
  date_of_birth: "SENTINEL-dob", sms_phone: "SENTINEL-sms-phone",
  fitzpatrick_type: 4, skin_notes: "SENTINEL-skin", allergies: "SENTINEL-allergies",
  emergency_contact_name: "SENTINEL-ec-name", emergency_contact_phone: "SENTINEL-ec-phone",
  contraindications: "SENTINEL-contraindications", photo_consent: true, notes: "SENTINEL-notes",
  created_at: "SENTINEL-created", created_by: "SENTINEL-created-by",
  archived_at: null, archived_by: "SENTINEL-archived-by",
  sms_consent_at: "SENTINEL-consent-at", sms_consent_source: "SENTINEL-consent-src",
  sms_opted_out_at: null, sms_opt_out_source: null, normalized_email: "SENTINEL-normalized",
};

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    studio: { id: "studio-1" },
    practitioner: { id: "p1", role: "owner" },
  }),
}));

// A chainable fake: the clients table returns the full row once (then an empty
// block), every other table is empty.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      let afterId = false;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "is", "not", "in", "lte", "gte", "lt", "order"]) q[m] = () => q;
      q.gt = () => { afterId = true; return q; };
      q.range = async () => ({ data: table === "clients" && !afterId ? [FULL_ROW] : [], error: null });
      return q;
    },
  }),
}));

// Only WHAT the page hands its components matters here.
vi.mock("@/components/pending-link", () => ({ PendingLink: () => null }));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/(app)/clients/[id]/actions", () => ({ unarchiveClientAction: async () => {} }));

import ClientsPage from "@/app/(app)/clients/page";
import { DirectoryResults } from "@/app/(app)/clients/ClientsDirectory";

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children as ReactNode, type);
}

describe("DAT-001 /clients hands its components only what it renders", () => {
  it("passes the projected row fields and no other client value", async () => {
    const tree = await ClientsPage({ searchParams: Promise.resolve({}) });
    const results = findElement(tree, DirectoryResults);
    expect(results).not.toBeNull();
    const data = results!.props.data as { rows: Array<Record<string, unknown>>; total: number };
    expect(data.total).toBe(1);
    expect(Object.keys(data.rows[0]).sort()).toEqual([
      "archivedAt", "displayName", "email", "id", "intake", "nameOnFile", "next", "phone", "pronouns",
    ]);
    expect(data.rows[0]).toMatchObject({
      id: "c1", displayName: "Visible Name", pronouns: "they/them",
      phone: "+1 555 0100", email: "visible@example.test",
    });
    expect(JSON.stringify(results!.props)).not.toContain("SENTINEL");
  });
});
