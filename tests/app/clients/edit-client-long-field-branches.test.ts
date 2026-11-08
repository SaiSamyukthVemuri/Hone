import { beforeEach, describe, expect, it, vi } from "vitest";

// #1328 + 0281: the long-field save is ONE database call (update_client_profile_if_unchanged) that compares in the JSON body,
// so there is no read-then-write gap. A NULL answer is "not saved" and the follow-up read says why. Synthetic values.

const db = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  // What the row holds NOW (the colleague's write, if any). kind decides the follow-up read after a NULL answer.
  stored: { kind: "value" as "value" | "error" | "missing", value: null as string | null },
  rpcError: null as { code: string; message: string } | null,
  reads: 0,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1", role: "owner" }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      if (db.rpcError) return { data: null, error: db.rpcError };
      const expected = args.p_expected as Record<string, unknown>;
      // The database compares every expected key; this fixture only models allergies.
      const same = !("allergies" in expected) || (expected.allergies ?? null) === db.stored.value;
      return { data: same ? "client-x" : null, error: null };
    },
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
            db.reads += 1;
            if (db.stored.kind === "error") return { data: null, error: { code: "XX000", message: "boom" } };
            if (db.stored.kind === "missing") return { data: null, error: null };
            return { data: { allergies: db.stored.value }, error: null };
          }
          return { data: { id: "client-x", name: "Bob Lee", phone: null, date_of_birth: null }, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
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
  db.rpcCalls = [];
  db.stored = { kind: "value", value: BIG };
  db.rpcError = null;
  db.reads = 0;
});

describe("long-field save in updateClientAction (atomic, 0281)", () => {
  it("unchanged underneath: ONE function call carries the new value and the loaded value, with no read first", async () => {
    const { redirected } = await run({ allergies: BIG + "Y" });
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0].name).toBe("update_client_profile_if_unchanged");
    expect(db.rpcCalls[0].args).toMatchObject({
      p_studio_id: "studio-A",
      p_client_id: "client-x",
      p_patch: { allergies: BIG + "Y" },
      p_expected: { allergies: BIG },
    });
    expect(db.reads).toBe(0);
    expect(redirected).toBe("/clients/client-x");
  });

  it("a database error on the write is a generic failure and no success", async () => {
    db.rpcError = { code: "XX000", message: "boom" };
    const { result, redirected } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({ ok: false });
    expect(redirected).toBeNull();
  });

  it("not saved and the follow-up read fails: 'not saved'", async () => {
    db.stored = { kind: "error", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not saved/i) });
  });

  it("not saved and the row is gone: 'Client not found'", async () => {
    db.stored = { kind: "missing", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toEqual({ ok: false, error: "Client not found." });
  });

  it("a change underneath is the conflict review with the colleague's text", async () => {
    db.stored = { kind: "value", value: "latex (added by a colleague)" };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Someone else changed/),
      conflicts: [{ key: "allergies", current: "latex (added by a colleague)", yours: BIG + "Y" }],
    });
  });

  it("a cleared field underneath is also a conflict", async () => {
    db.stored = { kind: "value", value: null };
    const { result } = await run({ allergies: BIG + "Y" });
    expect(result).toMatchObject({ ok: false, conflicts: [{ key: "allergies", current: "" }] });
  });

  it("a small-field edit sends only the changed key, and an unchanged long field is not compared", async () => {
    await run({ pronouns: "they/them", allergies: BIG });
    expect(db.rpcCalls).toHaveLength(1);
    const { p_patch, p_expected } = db.rpcCalls[0].args as { p_patch: Record<string, unknown>; p_expected: Record<string, unknown> };
    expect(JSON.parse(JSON.stringify(p_patch))).toEqual({ pronouns: "they/them" });
    expect(Object.keys(p_expected)).toEqual(["pronouns"]);
  });
});
