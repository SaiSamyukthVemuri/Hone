import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 slice 4: staff record a client's LEGAL identity. Same client row,
// staff-entered only, validated, signed-in client only (never admin), and a
// failure is a clean message with no name in the log. Synthetic names.

const db = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  /** Rows the conditional update reports changing; 0 = somebody else changed a part first. */
  updatedRows: 1,
  insertCode: null as string | null,
  current: { legal_given_name: "Dana", legal_middle_name: null, legal_family_name: "Okafor" } as Record<string, unknown> | null,
  clientFound: true,
  clientReadFails: false,
  upsertFails: false,
  logs: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => { throw new Error("legal identity must never use the service role"); },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1", role: "owner" }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "clients") {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () =>
            db.clientReadFails
              ? { data: null, error: { code: "57014", message: "contains Dana Reyes" } }
              : { data: db.clientFound ? { id: "client-1" } : null, error: null },
        };
        return q;
      }
      expect(table).toBe("client_legal_identities");
      const failure = { code: "42501", message: "row Dana Reyes" };
      return {
        insert: async (row: Record<string, unknown>) => {
          db.inserts.push(row);
          return { error: db.upsertFails ? failure : db.insertCode ? { code: db.insertCode, message: "dup" } : null };
        },
        update: (patch: Record<string, unknown>) => {
          const rec = { patch, filters: [] as Array<[string, string, unknown]> };
          db.updates.push(rec);
          const q: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { rec.filters.push(["eq", c, v]); return q; },
            is: (c: string, v: unknown) => { rec.filters.push(["is", c, v]); return q; },
            select: async () => db.upsertFails
              ? { data: null, error: failure }
              : { data: Array.from({ length: db.updatedRows }, () => ({ client_id: "client-1" })), error: null },
            // the conflict re-read
          };
          return q;
        },
        select: () => {
          const r: Record<string, unknown> = { eq: () => r, maybeSingle: async () => ({ data: db.current, error: null }) };
          return r;
        },
      };
    },
  }),
}));

import { saveLegalIdentityAction } from "@/app/(app)/clients/[id]/legal-identity-actions";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const NO_ROW = "none";
const LOADED = JSON.stringify({ given: "Dana", middle: null, family: "Okafor" });
const GOOD = { client_id: "client-1", legal_given_name: "Dana", legal_middle_name: "", legal_family_name: "Reyes-Okafor", legal_baseline: LOADED };

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.updatedRows = 1;
  db.insertCode = null;
  db.current = { legal_given_name: "Dana", legal_middle_name: null, legal_family_name: "Okafor" };
  db.clientFound = true;
  db.clientReadFails = false;
  db.upsertFails = false;
  db.logs = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => { db.logs.push(String(m)); });
});

describe("saveLegalIdentityAction", () => {
  it("first save inserts one row, trimmed, staff_entry, stamped with the practitioner and studio", async () => {
    const res = await saveLegalIdentityAction(fd({ ...GOOD, legal_baseline: NO_ROW, legal_given_name: "  Dana  ", legal_middle_name: "  " }));
    expect(res).toEqual({ ok: true, value: { given: "Dana", middle: "", family: "Reyes-Okafor" } });
    expect(db.inserts).toEqual([{
      client_id: "client-1",
      studio_id: "studio-A",
      legal_given_name: "Dana",
      legal_middle_name: null,
      legal_family_name: "Reyes-Okafor",
      source: "staff_entry",
      updated_by: "prac-1",
    }]);
    expect(db.updates).toHaveLength(0);
  });

  it("a later save is ONE conditional update that holds every loaded part", async () => {
    const res = await saveLegalIdentityAction(fd(GOOD));
    expect(res).toMatchObject({ ok: true });
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([
      ["eq", "client_id", "client-1"], ["eq", "studio_id", "studio-A"],
      ["eq", "legal_given_name", "Dana"], ["is", "legal_middle_name", null], ["eq", "legal_family_name", "Okafor"],
    ]));
  });

  it("zero rows changed is NOT saved: a conflict with what is stored now, and no success", async () => {
    db.updatedRows = 0;
    db.current = { legal_given_name: "Dana", legal_middle_name: "Q", legal_family_name: "Okafor" };
    const res = await saveLegalIdentityAction(fd(GOOD));
    expect(res).toMatchObject({ ok: false, current: { given: "Dana", middle: "Q", family: "Okafor" } });
  });

  it("a row that appeared after the page loaded refuses the insert as a conflict", async () => {
    db.insertCode = "23505";
    const res = await saveLegalIdentityAction(fd({ ...GOOD, legal_baseline: NO_ROW }));
    expect(res).toMatchObject({ ok: false, current: expect.anything() });
  });

  it("a form without the loaded legal name (an older page) is refused before any read or write", async () => {
    const { legal_baseline: _drop, ...older } = GOOD;
    const res = await saveLegalIdentityAction(fd(older));
    expect(res.ok).toBe(false);
    expect(db.inserts.length + db.updates.length).toBe(0);
  });

  it.each([
    ["no names at all", { legal_given_name: "", legal_family_name: "" }],
    ["only a middle name", { legal_given_name: "", legal_middle_name: "M", legal_family_name: "" }],
    ["a part over 200 characters", { legal_family_name: "x".repeat(201) }],
  ])("refuses %s and writes nothing", async (_l, over) => {
    const res = await saveLegalIdentityAction(fd({ ...GOOD, ...over }));
    expect(res.ok).toBe(false);
    expect(db.inserts.concat(db.updates as never[])).toHaveLength(0);
  });

  it("refuses a missing client id and a client that is not this studio's", async () => {
    expect((await saveLegalIdentityAction(fd({ ...GOOD, client_id: "" }))).ok).toBe(false);
    db.clientFound = false;
    expect(await saveLegalIdentityAction(fd(GOOD))).toEqual({ ok: false, error: "Client not found." });
    expect(db.inserts.concat(db.updates as never[])).toHaveLength(0);
  });

  it("a failed write is a generic message and the log line carries a code, never a name", async () => {
    db.upsertFails = true;
    const res = await saveLegalIdentityAction(fd(GOOD));
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Couldn.t save the legal name/) });
    db.clientReadFails = true;
    db.upsertFails = false;
    expect((await saveLegalIdentityAction(fd(GOOD))).ok).toBe(false);
    expect(db.logs.length).toBeGreaterThan(0);
    for (const line of db.logs) {
      expect(line).not.toContain("Dana");
      expect(line).not.toContain("Reyes");
      expect(JSON.parse(line)).toHaveProperty("code");
    }
  });
});
