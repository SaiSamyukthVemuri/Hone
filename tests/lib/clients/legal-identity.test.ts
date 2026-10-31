import { describe, expect, it } from "vitest";
import {
  readLegalIdentity,
  readLegalNamesForClients,
  readLegalNamesForStudio,
} from "@/lib/clients/legal-identity";
import { parseLegalIdentity, parsePreferredName } from "@/lib/clients/identity";

// HON-58: legal identity reads are signed-in reads that report "unavailable"
// separately from "none", page by id, and never invent a name. Synthetic.

type Row = { client_id: string; studio_id?: string; legal_given_name: string | null; legal_middle_name: string | null; legal_family_name: string | null };

function fake(rows: Row[], opts: { failAfterPages?: number; maxRows?: number } = {}) {
  let pages = 0;
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      calls.push(table);
      return {
        select() {
          const filters: Array<(r: Row) => boolean> = [];
          let from = 0;
          let to = Infinity;
          const q = {
            eq: (c: string, v: string) => { filters.push((r) => (r as Record<string, unknown>)[c] === v); return q; },
            in: (c: string, v: string[]) => { filters.push((r) => v.includes((r as Record<string, unknown>)[c] as string)); return q; },
            gt: (c: string, v: string) => { filters.push((r) => ((r as Record<string, unknown>)[c] as string) > v); return q; },
            order: () => q,
            range: (a: number, b: number) => { from = a; to = b; return q; },
            maybeSingle: async () => {
              const r = rows.filter((x) => filters.every((f) => f(x)))[0] ?? null;
              return { data: r, error: null };
            },
            then: (resolve: (v: unknown) => unknown) => {
              pages++;
              if (opts.failAfterPages !== undefined && pages > opts.failAfterPages) {
                return Promise.resolve({ data: null, error: { code: "57014" } }).then(resolve);
              }
              const sorted = rows.filter((x) => filters.every((f) => f(x))).sort((a, b) => (a.client_id < b.client_id ? -1 : 1));
              const cap = opts.maxRows ?? 1000;
              return Promise.resolve({ data: sorted.slice(from, Math.min(to + 1, from + cap)), error: null }).then(resolve);
            },
          };
          return q;
        },
      };
    },
  };
  return { supabase, calls };
}

const A = (id: string, given: string | null, family: string | null, middle: string | null = null, studio = "s1"): Row => ({
  client_id: id, studio_id: studio, legal_given_name: given, legal_middle_name: middle, legal_family_name: family,
});

describe("readLegalIdentity", () => {
  it("returns the row, or null when none is recorded", async () => {
    const { supabase } = fake([A("c1", "Dana", "Reyes")]);
    expect(await readLegalIdentity(supabase, "c1")).toMatchObject({ ok: true, value: { legal_given_name: "Dana" } });
    expect(await readLegalIdentity(supabase, "c2")).toEqual({ ok: true, value: null });
  });
});

describe("readLegalNamesForStudio", () => {
  it("maps client id to the combined legal name, only this studio's rows", async () => {
    const { supabase } = fake([A("c1", "Dana", "Reyes", "Marie"), A("c2", "Fiona", "Foreign", null, "s2"), A("c3", null, "Solo")]);
    const res = await readLegalNamesForStudio(supabase, "s1");
    expect(res.ok && [...res.value.entries()]).toEqual([["c1", "Dana Marie Reyes"], ["c3", "Solo"]]);
  });

  it("pages past a server row cap shorter than the page (a short page is not the end)", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => A(`c${String(i).padStart(3, "0")}`, "G", `F${i}`));
    const { supabase } = fake(rows, { maxRows: 10 });
    const res = await readLegalNamesForStudio(supabase, "s1");
    expect(res.ok && res.value.size).toBe(25);
  });

  it("a failed page is unavailable, never a partial map", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => A(`c${String(i).padStart(3, "0")}`, "G", `F${i}`));
    const { supabase } = fake(rows, { maxRows: 10, failAfterPages: 1 });
    expect(await readLegalNamesForStudio(supabase, "s1")).toEqual({ ok: false });
  });
});

describe("readLegalNamesForClients", () => {
  it("reads only the clients asked for, in chunks, de-duplicated", async () => {
    const { supabase } = fake([A("c1", "Dana", "Reyes"), A("c2", "Eli", "Stone"), A("c9", "Other", "Person")]);
    const res = await readLegalNamesForClients(supabase, ["c1", "c2", "c1"]);
    expect(res.ok && [...res.value.keys()].sort()).toEqual(["c1", "c2"]);
  });
  it("a failure is unavailable", async () => {
    const { supabase } = fake([A("c1", "Dana", "Reyes")], { failAfterPages: 0 });
    expect(await readLegalNamesForClients(supabase, ["c1"])).toEqual({ ok: false });
  });
});

describe("parsers", () => {
  it("parsePreferredName: blank is none, spaces collapse, over 200 is refused", () => {
    expect(parsePreferredName("  Janie   S ")).toEqual({ ok: true, value: "Janie S" });
    expect(parsePreferredName("   ")).toEqual({ ok: true, value: null });
    expect(parsePreferredName(null)).toEqual({ ok: true, value: null });
    expect(parsePreferredName("x".repeat(201)).ok).toBe(false);
  });
  it("parseLegalIdentity: needs a given or family name; middle alone is refused", () => {
    expect(parseLegalIdentity({ given: "Dana", family: " " })).toEqual({
      ok: true, value: { legal_given_name: "Dana", legal_middle_name: null, legal_family_name: null },
    });
    expect(parseLegalIdentity({ middle: "M" }).ok).toBe(false);
    expect(parseLegalIdentity({ given: "x".repeat(201) }).ok).toBe(false);
  });
});
