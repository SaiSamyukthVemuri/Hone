import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Client groups were removed from the product. Old links land on the standard directory, and no group control, link,
// search entry or read remains.
const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { mocks.redirect(to); throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ push: () => undefined }), usePathname: () => "/clients", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { role: "owner" }, studio: { id: "s", timezone: "UTC" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { throw new Error("no database read may happen before the redirect"); } }));

const read = (p: string) => readFileSync(p, "utf8");

describe("removed client groups", () => {
  beforeEach(() => mocks.redirect.mockClear());

  it("/clients/groups redirects to /clients and reads nothing", async () => {
    const { default: Page } = await import("@/app/(app)/clients/groups/page");
    expect(() => Page()).toThrow("REDIRECT:/clients");
  });

  it("an old ?group= link redirects to /clients keeping only the standard view, search, filters and sort", async () => {
    const { default: Page } = await import("@/app/(app)/clients/page");
    const go = async (sp: Record<string, string | string[]>) => {
      await expect(Page({ searchParams: Promise.resolve(sp) })).rejects.toThrow(/^REDIRECT:/);
      return mocks.redirect.mock.calls.at(-1)![0] as string;
    };
    expect(await go({ group: "3f2c0000-0000-4000-8000-000000000000" })).toBe("/clients");
    const kept = await go({ group: "x", q: "ann", filter: "no_upcoming", sort: "next", client: "c1", page: "4", evil: "https://example.test" });
    expect(kept).toBe("/clients?q=ann&filter=no_upcoming&sort=next");
    expect(kept).not.toMatch(/group|evil|example|client=|page=/);
    expect(await go({ group: "x", view: "archived", q: "ann" })).toBe("/clients?view=archived&q=ann");
  });

  it("the directory URL builder can no longer emit a group", async () => {
    const { directoryHref } = await import("@/lib/clients/directory-query");
    expect(directoryHref({ view: "active", ...({ group: "x" } as object) })).toBe("/clients");
  });

  it("no group code, control, link or search entry remains", () => {
    for (const gone of ["lib/client-groups", "app/(app)/clients/ClientGroups.tsx", "app/(app)/clients/group-actions.ts", "e2e/client-groups.spec.ts"]) {
      expect(existsSync(gone), `${gone} is removed`).toBe(false);
    }
    for (const f of ["app/(app)/clients/page.tsx", "app/(app)/clients/ClientsDirectory.tsx", "app/(app)/clients/DirectoryControls.tsx", "app/(app)/clients/[id]/page.tsx", "lib/search/navigation-registry.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/client-groups|client_groups|ClientGroup|Manage groups|Client groups|All groups/);
    }
    expect(read("lib/search/navigation-registry.ts")).not.toContain('href: "/clients/groups"');
  });
});
