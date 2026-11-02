import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 slice 4: staff record a client's LEGAL identity. Same client row,
// staff-entered only, validated, signed-in client only (never admin), and a
// failure is a clean message with no name in the log. Synthetic names.

const db = vi.hoisted(() => ({
  upserts: [] as Array<{ row: Record<string, unknown>; opts: unknown }>,
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
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1" }, studio: { id: "studio-A" } }),
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
      return {
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          db.upserts.push({ row, opts });
          return { error: db.upsertFails ? { code: "42501", message: "row Dana Reyes" } : null };
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
const GOOD = { client_id: "client-1", legal_given_name: "Dana", legal_middle_name: "", legal_family_name: "Reyes-Okafor" };

beforeEach(() => {
  db.upserts = [];
  db.clientFound = true;
  db.clientReadFails = false;
  db.upsertFails = false;
  db.logs = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => { db.logs.push(String(m)); });
});

describe("saveLegalIdentityAction", () => {
  it("upserts one row for the client, trimmed, staff_entry, stamped with the practitioner and studio", async () => {
    const res = await saveLegalIdentityAction(fd({ ...GOOD, legal_given_name: "  Dana  ", legal_middle_name: "  " }));
    expect(res).toEqual({ ok: true });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].row).toEqual({
      client_id: "client-1",
      studio_id: "studio-A",
      legal_given_name: "Dana",
      legal_middle_name: null,
      legal_family_name: "Reyes-Okafor",
      source: "staff_entry",
      updated_by: "prac-1",
    });
    expect(db.upserts[0].opts).toEqual({ onConflict: "client_id" });
  });

  it.each([
    ["no names at all", { legal_given_name: "", legal_family_name: "" }],
    ["only a middle name", { legal_given_name: "", legal_middle_name: "M", legal_family_name: "" }],
    ["a part over 200 characters", { legal_family_name: "x".repeat(201) }],
  ])("refuses %s and writes nothing", async (_l, over) => {
    const res = await saveLegalIdentityAction(fd({ ...GOOD, ...over }));
    expect(res.ok).toBe(false);
    expect(db.upserts).toHaveLength(0);
  });

  it("refuses a missing client id and a client that is not this studio's", async () => {
    expect((await saveLegalIdentityAction(fd({ ...GOOD, client_id: "" }))).ok).toBe(false);
    db.clientFound = false;
    expect(await saveLegalIdentityAction(fd(GOOD))).toEqual({ ok: false, error: "Client not found." });
    expect(db.upserts).toHaveLength(0);
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
