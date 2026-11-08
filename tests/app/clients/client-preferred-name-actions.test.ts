import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 slice 4: the preferred name is written to the SAME client row by
// staff create and edit. It is trimmed (the database check requires it), blank
// means none, too long is refused rather than cut, and an edit whose form did
// not submit the field never touches it. Synthetic names only.

const db = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  updateFilters: [] as Array<[string, unknown]>,
  practitionerFails: false,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    // A receptionist is not a practitioners row, so the resolver refuses them before any write.
    if (db.practitionerFails) throw new Error("not a practitioner");
    return { practitioner: { id: "prac-1", role: "owner" }, studio: { id: "studio-A" } };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    // 0281: the edit is ONE function call. Record its patch (defined keys only, as the JSON body carries it) and its scope
    // exactly where the old chain recorded `.update(row)` and the id / studio filters.
    rpc: async (name: string, args: { p_studio_id: string; p_client_id: string; p_patch: Record<string, unknown> }) => {
      expect(name).toBe("update_client_profile_if_unchanged");
      db.updates.push(JSON.parse(JSON.stringify(args.p_patch)));
      db.updateFilters.push(["id", args.p_client_id], ["studio_id", args.p_studio_id]);
      return { data: args.p_client_id, error: null };
    },
    from: (table: string) => {
      expect(table).toBe("clients");
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        is: () => query,
        gt: () => query,
        order: () => query,
        range: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: { id: "client-x", name: "Bob Lee", phone: null, date_of_birth: null }, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        insert: (row: Record<string, unknown>) => {
          db.inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "new-client" }, error: null }) }) };
        },
        update: (row: Record<string, unknown>) => {
          db.updates.push(row);
          const u: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { db.updateFilters.push([c, v]); return u; },
            is: (c: string, v: unknown) => { db.updateFilters.push([c, v]); return u; },
            select: async () => ({ data: [{ id: "client-x" }], error: null }),
          };
          return u;
        },
      };
      return query;
    },
  }),
}));

import { createClientAction } from "@/app/(app)/clients/new/actions";
import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

// What the edit page loaded (the action writes only fields that differ from it).
const LOADED = {
  name: "Bob Lee", preferred_name: null, pronouns: null, date_of_birth: null, phone: null, email: null,
  address: null, fitzpatrick_type: null, allergies: null, emergency_contact_name: null, emergency_contact_phone: null,
};
async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (action === updateClientAction && !fd.has("baseline")) fd.set("baseline", JSON.stringify(LOADED));
  try {
    return { result: await action(fd), redirected: null as string | null };
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (!m) throw err;
    return { result: undefined, redirected: m[1] };
  }
}

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.updateFilters = [];
  db.practitionerFails = false;
});

describe("staff create writes the preferred name on the one client row", () => {
  it("stores a trimmed, space-collapsed preferred name beside the stored name", async () => {
    const { redirected } = await run(createClientAction, { name: "Jane Smith", preferred_name: "  Janie   S  " });
    expect(redirected).toMatch(/^\/clients\//);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ name: "Jane Smith", preferred_name: "Janie S" });
  });

  it.each([["blank", "   "], ["absent", ""]])("a %s preferred name is stored as null", async (_l, value) => {
    await run(createClientAction, { name: "Jane Smith", preferred_name: value });
    expect(db.inserts[0]).toMatchObject({ preferred_name: null });
  });

  it("refuses a preferred name over 200 characters and inserts nothing", async () => {
    const { result } = await run(createClientAction, { name: "Jane Smith", preferred_name: "x".repeat(201) });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Preferred name/) });
    expect(db.inserts).toHaveLength(0);
  });
});

describe("staff edit writes the preferred name only when the form submitted it", () => {
  const base = { client_id: "client-x", name: "Bob Lee" };

  it("saves a changed preferred name and a cleared one (null)", async () => {
    await run(updateClientAction, { ...base, preferred_name: "Bobby" });
    // Only the changed field is written: the unchanged name is not sent back.
    expect(db.updates[0]).toEqual({ preferred_name: "Bobby" });
    // Clearing is an explicit action against a stored value, never a blank by omission.
    const loaded = JSON.stringify({ ...LOADED, preferred_name: "Bobby" });
    await run(updateClientAction, { ...base, preferred_name: "", baseline: loaded, clear_preferred_name: "yes" });
    expect(db.updates[1]).toEqual({ preferred_name: null });
  });

  it("a blanked preferred name without the explicit clear action is refused and writes nothing", async () => {
    const loaded = JSON.stringify({ ...LOADED, preferred_name: "Bobby" });
    const { result } = await run(updateClientAction, { ...base, preferred_name: "", baseline: loaded });
    expect(result).toMatchObject({ ok: false });
    expect(db.updates).toHaveLength(0);
  });

  it("an older form with no preferred_name field leaves the stored preferred name alone", async () => {
    const loaded = JSON.stringify({ ...LOADED, preferred_name: "Bobby" });
    await run(updateClientAction, { ...base, baseline: loaded });
    // Nothing differs and nothing was submitted for it: no write at all, and the column is never named.
    expect(db.updates).toHaveLength(0);
    await run(updateClientAction, { ...base, baseline: loaded, pronouns: "they/them" });
    expect(db.updates[0]).toEqual({ pronouns: "they/them" });
  });

  it("refuses a too-long preferred name and updates nothing", async () => {
    const { result } = await run(updateClientAction, { ...base, preferred_name: "y".repeat(201) });
    expect(result).toMatchObject({ ok: false });
    expect(db.updates).toHaveLength(0);
  });
});

describe("who may edit, and where the write lands", () => {
  it("a caller that is not an owner or practitioner (a receptionist) reaches no write", async () => {
    db.practitionerFails = true;
    await expect(run(updateClientAction, { client_id: "client-x", name: "Bob Lee", preferred_name: "Bobby" })).rejects.toThrow();
    await expect(run(createClientAction, { name: "Jane Smith", preferred_name: "Janie" })).rejects.toThrow();
    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("the update is scoped to the caller's studio and the one client; the insert carries the caller's studio", async () => {
    await run(updateClientAction, { client_id: "client-x", name: "Bob Lee", preferred_name: "Bobby" });
    expect(db.updateFilters).toEqual(expect.arrayContaining([["id", "client-x"], ["studio_id", "studio-A"]]));
    await run(createClientAction, { name: "Jane Smith", preferred_name: "Janie" });
    expect(db.inserts[0]).toMatchObject({ studio_id: "studio-A" });
  });

  it("an edit never changes the stored name unless the form submitted one, and never writes preferred_name from another field", async () => {
    await run(updateClientAction, { client_id: "client-x", name: "Bob Lee", preferred_name: "Bobby" });
    expect(db.updates[0]).toEqual({ preferred_name: "Bobby" });
    // Saving a preferred name leaves `name` as typed: no automatic rename in either direction.
    expect(db.updates[0].name).toBeUndefined();
  });
});
