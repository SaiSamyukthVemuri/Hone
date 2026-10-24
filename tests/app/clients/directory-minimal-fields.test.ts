import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// DAT-001 minimal returned fields. /clients used to hand whole clients rows
// to ClientSearch, a client component, so every column was serialized into
// the browser's RSC payload although the list renders only name, pronouns,
// phone and email (plus the id for the link). This pins that ClientSearch
// receives exactly those five fields and no other client value. The directory
// read's own column list is pinned in
// tests/lib/supabase/client-directory-columns.test.ts.

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
  archived_at: "SENTINEL-archived-at", archived_by: "SENTINEL-archived-by",
  sms_consent_at: "SENTINEL-consent-at", sms_consent_source: "SENTINEL-consent-src",
  sms_opted_out_at: null, sms_opt_out_source: null, normalized_email: "SENTINEL-normalized",
};

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ studio: { id: "studio-1" } }),
  getClientsForStudio: async () => [FULL_ROW],
  getArchivedClientsForStudio: async () => [],
}));

// Only WHAT the page hands the client component matters here.
vi.mock("@/components/client-search", () => ({ ClientSearch: () => null }));
vi.mock("@/components/pending-link", () => ({ PendingLink: () => null }));

import ClientsPage from "@/app/(app)/clients/page";
import { ClientSearch } from "@/components/client-search";

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

describe("DAT-001 /clients hands ClientSearch only what it renders", () => {
  it("passes exactly id, name, pronouns, phone and email, and no other client value", async () => {
    const tree = await ClientsPage({ searchParams: Promise.resolve({}) });
    const search = findElement(tree, ClientSearch);
    expect(search).not.toBeNull();
    const clients = search!.props.clients as Array<Record<string, unknown>>;
    expect(clients).toEqual([{
      id: "c1", name: "Visible Name", pronouns: "they/them",
      phone: "+1 555 0100", email: "visible@example.test",
    }]);
    expect(JSON.stringify(search!.props)).not.toContain("SENTINEL");
  });
});
