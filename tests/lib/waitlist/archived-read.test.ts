import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ eqs: [] as Array<[string, unknown]>, result: { data: [] as unknown, error: null as unknown } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (t: string) => {
      h.eqs.push(["from", t]);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { h.eqs.push([c, v]); return q; },
        order: () => q,
        limit: () => Promise.resolve(h.result),
      };
      return q;
    },
  }),
}));

const { listArchivedEntries } = await import("@/lib/waitlist/entry-search");
const read = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");

beforeEach(() => { h.eqs = []; h.result = { data: [], error: null }; });

describe("the Archived read lists ONLY removed entries, ONLY of this studio", () => {
  it("filters on status 'removed' and on the studio id, from the entries table", async () => {
    await listArchivedEntries("studio-1");
    expect(h.eqs).toContainEqual(["from", "new_client_waitlist_entries"]);
    expect(h.eqs).toContainEqual(["status", "removed"]);
    expect(h.eqs).toContainEqual(["studio_id", "studio-1"]);
    expect(h.eqs.filter(([c]) => c === "status")).toHaveLength(1);
  });
  it("source: the function body pins both filters in code, so widening the status or dropping the studio fails here", () => {
    const src = read("lib/waitlist/entry-search.ts");
    const body = src.slice(src.indexOf("export async function listArchivedEntries"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).toContain('.eq("status", "removed")');
    expect(fn).toContain('.eq("studio_id", studioId)');
    expect(fn).not.toMatch(/\.in\("status"|\.neq\(|\.or\(/);
  });
});

describe("the Archived page never links to a queue anchor", () => {
  it("passes showEntryLink={false}, because a removed entry is not in the queue and the anchor would land on nothing", () => {
    const page = read("app/(app)/settings/waitlist/archived/page.tsx");
    const el = page.slice(page.indexOf("<ReplyContactDetails"), page.indexOf("/>", page.indexOf("<ReplyContactDetails")));
    expect(el).toContain("showEntryLink={false}");
  });
});
