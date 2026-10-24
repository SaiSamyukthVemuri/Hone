import { beforeEach, describe, expect, it, vi } from "vitest";

// DAT-001 minimal returned fields: the client directory read used to be
// `select("*")`, returning every clients column (date of birth, allergies,
// contraindications, skin and private notes, emergency contacts, SMS consent
// evidence) to surfaces that use seven of them. It now names its columns on
// every page. The list is the union of what the directory's consumers read:
// /clients (ClientSearch, ArchivedClientsList), the calendar quick-book
// drawer, and the records exposed-person selector, procedure filter and print.
// tests/app/clients/directory-minimal-fields.test.ts pins what crosses to the
// browser.

const selects = vi.hoisted(() => [] as string[]);
const pages = vi.hoisted(() => ({ served: 0 }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const query = {
        select: (columns: string) => { selects.push(columns); return query; },
        eq: () => query,
        gt: () => query,
        is: () => query,
        not: () => query,
        order: () => query,
        range: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          // One page of one row, then the empty page that ends traversal.
          const data = pages.served++ === 0 ? [{ id: "c1", name: "A", archived_at: "2026-10-20T10:00:00Z" }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  }),
}));

import {
  CLIENT_DIRECTORY_COLUMNS,
  getArchivedClientsForStudio,
  getClientsForStudio,
} from "@/lib/supabase/queries";

beforeEach(() => { selects.length = 0; pages.served = 0; });

describe("DAT-001 the client directory read names its columns", () => {
  it("pins the exact directory column list", () => {
    expect(CLIENT_DIRECTORY_COLUMNS).toBe("id, name, pronouns, email, phone, address, archived_at");
  });

  it.each([false, true])("selects only those columns on every page (archived=%s)", async (archived) => {
    await (archived ? getArchivedClientsForStudio("A") : getClientsForStudio("A"));
    expect(selects).toHaveLength(2);
    for (const columns of selects) expect(columns).toBe("id, name, pronouns, email, phone, address, archived_at");
  });
});
