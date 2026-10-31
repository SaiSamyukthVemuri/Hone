import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 slice 4: the preferred name is written to the SAME client row by
// staff create and edit. It is trimmed (the database check requires it), blank
// means none, too long is refused rather than cut, and an edit whose form did
// not submit the field never touches it. Synthetic names only.

const db = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1" }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
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
          const u: Record<string, unknown> = { eq: () => u, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
          return u;
        },
      };
      return query;
    },
  }),
}));

import { createClientAction } from "@/app/(app)/clients/new/actions";
import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
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
    expect(db.updates[0]).toMatchObject({ name: "Bob Lee", preferred_name: "Bobby" });
    await run(updateClientAction, { ...base, preferred_name: "" });
    expect(db.updates[1]).toMatchObject({ preferred_name: null });
  });

  it("an older form with no preferred_name field leaves the stored preferred name alone", async () => {
    await run(updateClientAction, base);
    expect(db.updates).toHaveLength(1);
    expect(Object.keys(db.updates[0])).not.toContain("preferred_name");
  });

  it("refuses a too-long preferred name and updates nothing", async () => {
    const { result } = await run(updateClientAction, { ...base, preferred_name: "y".repeat(201) });
    expect(result).toMatchObject({ ok: false });
    expect(db.updates).toHaveLength(0);
  });
});
