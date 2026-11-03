import { beforeEach, describe, expect, it, vi } from "vitest";

// #1328 (Insurance M-2): the failure branches of the long-field read-compare in updateClientAction. A changed field over
// the URL threshold has no equality condition, so its current value is read just before the write. Synthetic values.

const db = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  longRead: { kind: "value" as "value" | "error" | "missing", value: null as string | null },
  longReads: 0,
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
    from: () => {
      let cols = "";
      const query: Record<string, unknown> = {
        select: (c: string) => { cols = c; return query; },
        eq: () => query,
        is: () => query,
        gt: () => query,
        order: () => query,
        range: () => query,
        limit: () => query,
        maybeSingle: async () => {
          if (cols === "allergies") {
            db.longReads += 1;
            if (db.longRead.kind === "error") return { data: null, error: { code: "XX000", message: "boom" } };
            if (db.longRead.kind === "missing") return { data: null, error: null };
            return { data: { allergies: db.longRead.value }, error: null };
          }
          return { data: { id: "client-x", name: "Bob Lee", phone: null, date_of_birth: null }, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        update: (row: Record<string, unknown>) => {
          db.updates.push(row);
          const u: Record<string, unknown> = {
            eq: () => u,
            is: () => u,
            select: async () => ({ data: [{ id: "client-x" }], error: null }),
          };
          return u;
        },
      };
      return query;
    },
  }),
}));

import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

const BIG = "a".repeat(25_000);
const LOADED = {
  name: "Bob Lee", preferred_name: null, pronouns: null, date_of_birth: null, phone: null, email: null,
  address: null, fitzpatrick_type: null, allergies: BIG, emergency_contact_name: null, emergency_contact_phone: null,
};
async function run(fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("client_id", "client-x");
  fd.set("name", "Bob Lee");
  fd.set("baseline", JSON.stringify(LOADED));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    return { result: await updateClientAction(fd), redirected: null as string | null };
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (!m) throw err;
    return { result: undefined, redirected: m[1] };
  }
}

beforeEach(() => {
  db.updates = [];
  db.longRead = { kind: "value", value: BIG };
  db.longReads = 0;
});

describe("long-field read-compare in updateClientAction", () => {
  it("unchanged underneath: the current value is read once, then the write happens with the new value", async () => {
    const { redirected } = await run({ allergies: BIG + "Y" });
    expect(db.longReads).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ allergies: BIG + "Y" });
    expect(redirected).toBe("/clients/client-x");
  });

  it("a read error is 'not saved' and nothing is written", async () => {
    db.longRead = { kind: "error", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not saved/i) });
    expect(db.updates).toHaveLength(0);
  });

  it("a missing row is 'Client not found' and nothing is written", async () => {
    db.longRead = { kind: "missing", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toEqual({ ok: false, error: "Client not found." });
    expect(db.updates).toHaveLength(0);
  });

  it("a change underneath is the conflict review with the colleague's text, and update is never called", async () => {
    db.longRead = { kind: "value", value: "latex (added by a colleague)" };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Someone else changed/),
      conflicts: [{ key: "allergies", current: "latex (added by a colleague)", yours: BIG + "Y" }],
    });
    expect(db.updates).toHaveLength(0);
  });

  it("a cleared field underneath is also a conflict, and update is never called", async () => {
    db.longRead = { kind: "value", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({ ok: false, conflicts: [{ key: "allergies", current: "" }] });
    expect(db.updates).toHaveLength(0);
  });

  it("a small-field edit never triggers the long-field read", async () => {
    await run({ pronouns: "they/them", allergies: BIG });
    expect(db.longReads).toBe(0);
    expect(db.updates).toHaveLength(1);
  });
});
