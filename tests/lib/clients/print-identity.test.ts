import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clinicalPacketName } from "@/lib/clients/identity";
import { readPrintIdentities } from "@/lib/clients/print-identity";

// HON-58 (OPS Q2): a printed clinical record carries the LEGAL name with the
// preferred name in parentheses; a client with neither prints the name on file;
// a failed read is reported (so the page can say so), never turned into a
// claimed legal name. Synthetic names.

type Opts = { hasPreferredColumn?: boolean; failClients?: boolean; failLegal?: boolean; legalTableMissing?: boolean; legalMissingOtherTable?: boolean };

function fake(opts: Opts = {}) {
  const preferred: Record<string, string | null> = { c1: "Maggie", c2: null };
  const legal: Record<string, { g: string | null; f: string | null }> = { c1: { g: "Margaret", f: "Okafor" } };
  const selects: string[] = [];
  const supabase = {
    from(table: string) {
      return {
        select(columns: string) {
          selects.push(`${table}:${columns}`);
          return {
            in(_col: string, ids: string[]) {
              if (table === "clients") {
                if (opts.failClients) return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
                if (columns.includes("preferred_name") && opts.hasPreferredColumn === false) {
                  return Promise.resolve({ data: null, error: { code: "42703", message: "column clients.preferred_name does not exist" } });
                }
                return Promise.resolve({
                  data: ids.filter((i) => i in preferred).map((id) => ({
                    id, name: `Stored ${id}`,
                    ...(columns.includes("preferred_name") ? { preferred_name: preferred[id] } : {}),
                  })),
                  error: null,
                });
              }
              if (opts.legalTableMissing) return Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.client_legal_identities' in the schema cache" } });
              if (opts.legalMissingOtherTable) return Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.something_else' in the schema cache" } });
              if (opts.failLegal) return Promise.resolve({ data: null, error: { code: "42501", message: "denied" } });
              return Promise.resolve({
                data: ids.filter((i) => i in legal).map((id) => ({
                  client_id: id, legal_given_name: legal[id].g, legal_middle_name: null, legal_family_name: legal[id].f,
                })),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  return { supabase, selects };
}

describe("readPrintIdentities", () => {
  it("before 0258 (no legal table) is ok with no legal names: no 'could not load' notice", async () => {
    const { supabase } = fake({ legalTableMissing: true, hasPreferredColumn: false });
    const res = await readPrintIdentities(supabase, ["c1"]);
    expect(res.ok).toBe(true);
    expect(res.byClient.get("c1")).toEqual({ preferred_name: null, legal_name: null });
  });

  it("negative control: a missing DIFFERENT table is still unavailable", async () => {
    const { supabase } = fake({ legalMissingOtherTable: true });
    expect((await readPrintIdentities(supabase, ["c1"])).ok).toBe(false);
  });

  it("returns the preferred and the legal name per client, ok", async () => {
    const { supabase } = fake();
    const res = await readPrintIdentities(supabase, ["c1", "c2", "c1", ""]);
    expect(res.ok).toBe(true);
    expect(res.byClient.get("c1")).toEqual({ preferred_name: "Maggie", legal_name: "Margaret Okafor" });
    expect(res.byClient.get("c2")).toEqual({ preferred_name: null, legal_name: null });
  });

  it("before 0258 the preferred read falls back; a missing legal table is reported not ok", async () => {
    const { supabase } = fake({ hasPreferredColumn: false });
    const res = await readPrintIdentities(supabase, ["c1"]);
    expect(res.byClient.get("c1")?.preferred_name).toBeNull();
    expect(res.byClient.get("c1")?.legal_name).toBe("Margaret Okafor");
    expect(res.ok).toBe(true);
  });

  it.each<[string, Opts]>([["clients read", { failClients: true }], ["legal read", { failLegal: true }]])("a failed %s is ok:false, never a claimed name", async (_l, opts) => {
    const { supabase } = fake(opts);
    const res = await readPrintIdentities(supabase, ["c1"]);
    expect(res.ok).toBe(false);
    if (opts.failLegal) expect(res.byClient.get("c1")?.legal_name).toBeNull();
  });

  it("an empty list reads nothing", async () => {
    const { supabase, selects } = fake();
    expect(await readPrintIdentities(supabase, [])).toEqual({ ok: true, byClient: new Map() });
    expect(selects).toHaveLength(0);
  });
});

describe("the printed name (Q2)", () => {
  it("legal with the preferred in parentheses; stored name when neither is held", () => {
    expect(clinicalPacketName({ name: "Stored c1", preferred_name: "Maggie", legal_name: "Margaret Okafor" })).toBe("Margaret Okafor (Maggie)");
    expect(clinicalPacketName({ name: "Stored c2", preferred_name: null, legal_name: null })).toBe("Stored c2");
    expect(clinicalPacketName({ name: "Stored c3", preferred_name: "Cee" })).toBe("Stored c3 (Cee)");
  });
});

describe("the records print page", () => {
  const page = readFileSync("app/(app)/records/print/page.tsx", "utf8");
  it("prints the clinical packet name and says so when legal names could not be loaded", () => {
    expect(page).toMatch(/readPrintIdentities/);
    expect(page).toMatch(/clinicalPacketName/);
    expect(page).toMatch(/Legal names could not be loaded; this printout shows the names on file\./);
    expect(page).toMatch(/<FieldLine label="Client" value=\{notRecorded\(printedName\(r\)\)\} \/>/);
  });
  it("uses the signed-in client, never the admin client", () => {
    expect(page).not.toMatch(/createAdminClient|admin-server/);
  });
});
