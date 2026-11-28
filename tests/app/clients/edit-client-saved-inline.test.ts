import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-109 (client-form Save): "saved_inline" only changes HOW a SAVED edit is reported. This file is the paired proof. Header kept from the source it was
// derived from: HON-58, Team review of #1084 (I1): editing a client could turn the record
// into a probable duplicate (a phone or date of birth changed to another
// client's) with no warning. The edit path now runs #1084's matcher
// (lib/clients/possible-duplicate.ts, unchanged) when the edit changes an
// identity field (name, phone or date of birth), never counts the client
// being edited, and saves only when every probable duplicate was confirmed.
// An edit that leaves those fields alone is not re-warned about a duplicate
// that already existed.

type Row = {
  id: string; studio_id: string; name: string; phone: string | null; sms_phone: string | null;
  date_of_birth: string | null; archived_at: string | null; email?: string | null; allergies?: string | null; normalized_email?: string | null;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  updates: [] as Record<string, unknown>[],
  failMatcher: false,
  failStored: false,
  selects: [] as string[],
  role: "owner",
  rpcNoRow: false,
  rpcId: null as string | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { revalidated.push(p); } }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1", role: db.role }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    // 0281: the edit is one function call; record its patch where the old chain recorded `.update(row)`.
    rpc: async (_name: string, args: { p_client_id: string; p_patch: Record<string, unknown> }) => {
      db.updates.push(JSON.parse(JSON.stringify(args.p_patch)));
      return { data: db.rpcNoRow ? null : (db.rpcId ?? args.p_client_id), error: null };
    },
    from: (table: string) => {
      expect(table).toBe("clients");
      const filters: Array<[string, unknown]> = [];
      const negs: Array<[string, unknown]> = [];
      let columns = "";
      let limit = Infinity;
      let after: string | null = null;
      let ordered = false;
      let from = 0;
      let to = Infinity;
      const matching = () => db.rows.filter((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v) && negs.every(([k, v]) => (r as Record<string, unknown>)[k] !== v));
      const project = (r: Row) => Object.fromEntries(
        columns.split(",").map((c) => c.trim()).map((c) => [c, (r as Record<string, unknown>)[c]]),
      );
      const query = {
        select: (c: string) => { columns = c; db.selects.push(c); return query; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return query; },
        neq: (k: string, v: unknown) => { negs.push([k, v]); return query; },
        limit: (n: number) => { limit = n; return query; },
        // #1084's matcher pages by id (Codex P2 4365730664); a page holds at most 1000.
        gt: (k: string, v: string) => { expect(k).toBe("id"); after = v; return query; },
        order: (k: string, o: { ascending: boolean }) => { expect([k, o.ascending]).toEqual(["id", true]); ordered = true; return query; },
        range: (a: number, b: number) => { from = a; to = b; return query; },
        maybeSingle: async () => {
          if (db.failStored && columns !== "id") return { data: null, error: { code: "57014" } };
          const r = matching()[0];
          return { data: r ? project(r) : null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (db.failMatcher) return Promise.resolve({ data: null, error: { code: "57014" } }).then(resolve);
          let rows = matching();
          if (after !== null) rows = rows.filter((r) => r.id > (after as string));
          if (ordered) rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          rows = rows.slice(from, Math.min(to + 1, from + 1000)).slice(0, limit);
          return Promise.resolve({ data: rows.map(project), error: null }).then(resolve);
        },
        update: (row: Record<string, unknown>) => {
          db.updates.push(row);
          // update(patch).eq(...).is(...).select("id"): the conditional write reports the row it changed.
          const u = { eq: () => u, is: () => u, select: async () => ({ data: [{ id: "client-x" }], error: null }) };
          return u;
        },
      };
      return query;
    },
  }),
}));

import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

const BOB: Row = {
  id: "client-bob", studio_id: "studio-A", name: "Bob Lee", phone: "778-555-0100", sms_phone: "+17785550100",
  date_of_birth: "1980-03-04", archived_at: null, email: "bob@example.com", normalized_email: "bob@example.com", allergies: "none",
};
const JANE: Row = {
  id: "client-jane", studio_id: "studio-A", name: "Jane Smith", phone: "(604) 555-0199", sms_phone: "+16045550199",
  date_of_birth: "1990-01-02", archived_at: null, email: "jane@example.com", normalized_email: "jane@example.com", allergies: null,
};

const BASE = { name: "Bob Lee", preferred_name: null, pronouns: null, date_of_birth: "1980-03-04", phone: "778-555-0100", email: "bob@example.com", address: null,
  fitzpatrick_type: null, allergies: "none", emergency_contact_name: null, emergency_contact_phone: null };

type Outcome = { result: unknown; redirected: string | null };
async function run(fields: Record<string, string>, inline: boolean, baseline: unknown = BASE): Promise<Outcome> {
  const fd = new FormData();
  fd.set("client_id", "client-bob");
  for (const [k, v] of Object.entries({ name: "Bob Lee", phone: "778-555-0100", date_of_birth: "1980-03-04", email: "bob@example.com", allergies: "none", ...fields })) fd.set(k, v);
  if (baseline) fd.set("baseline", JSON.stringify(baseline));
  if (inline) fd.set("saved_inline", "1");
  try {
    return { result: await updateClientAction(fd), redirected: null };
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (!m) throw err;
    return { result: undefined, redirected: m[1] };
  }
}

beforeEach(() => {
  db.rows = [JANE, BOB]; db.updates = []; db.failMatcher = false; db.failStored = false; db.selects = []; db.role = "owner"; db.rpcNoRow = false; db.rpcId = null; revalidated.length = 0;
});

// Every REFUSAL must render exactly as today: the same object, with or without the flag, and nothing written.
describe("HON-109: the flag changes nothing about a refusal", () => {
  const cases: Array<[string, () => void, Record<string, string>, unknown?]> = [
    ["a stale form (no baseline)", () => undefined, { allergies: "latex" }, null],
    ["a probable duplicate (phone matches another client)", () => undefined, { phone: "604.555.0199" }],
    ["a duplicate email", () => undefined, { email: "jane@example.com" }],
    ["a changed-by-someone-else conflict (stale version)", () => { db.rpcNoRow = true; db.rows = [JANE, { ...BOB, allergies: "peanut" }]; }, { allergies: "latex" }],
    ["a refused role (permission refusal)", () => { db.role = "receptionist"; }, { allergies: "latex" }],
    ["a missing client id", () => undefined, { client_id: "" }],
  ];
  for (const [label, setup, fields, baseline] of cases) {
    it(`${label}: identical result, nothing saved, no redirect`, async () => {
      setup();
      const before = db.updates.length;
      const plain = await run(fields, false, baseline === undefined ? BASE : baseline);
      const plainWrites = db.updates.length - before;
      setup();
      const mid = db.updates.length;
      const inline = await run(fields, true, baseline === undefined ? BASE : baseline);
      expect(inline).toEqual(plain);
      expect(inline.redirected).toBeNull();
      expect(inline.result).toMatchObject({ ok: false });
      // The same number of write attempts either way (the stale-version conflict is a conditional write that matched no row).
      expect(db.updates.length - mid).toBe(plainWrites);
      if (!label.includes("conflict")) expect(plainWrites).toBe(0);
    });
  }
});

describe("HON-109: a SAVED edit", () => {
  it("without the flag still ends in redirect() to the profile (the fallback for any other caller)", async () => {
    const out = await run({ allergies: "latex" }, false);
    expect(out).toEqual({ result: undefined, redirected: "/clients/client-bob" });
    expect(db.updates).toHaveLength(1);
  });
  it("with the flag RETURNS ok and the server-built address, and saved exactly once", async () => {
    const out = await run({ allergies: "latex" }, true);
    expect(out).toEqual({ result: { ok: true, redirectTo: "/clients/client-bob" }, redirected: null });
    expect(db.updates).toHaveLength(1);
  });
  it("the redirect path revalidates the profile and the list; the inline path revalidates nothing (the soft navigation fetches fresh)", async () => {
    await run({ allergies: "latex" }, false);
    expect(revalidated).toEqual(["/clients/client-bob", "/clients"]);
    revalidated.length = 0;
    await run({ allergies: "aloe" }, true);
    expect(revalidated).toEqual([]);
  });
  it("nothing changed: flag returns ok too, plain redirects, neither writes", async () => {
    expect(await run({}, false)).toEqual({ result: undefined, redirected: "/clients/client-bob" });
    expect(await run({}, true)).toEqual({ result: { ok: true, redirectTo: "/clients/client-bob" }, redirected: null });
    expect(db.updates).toHaveLength(0);
  });
  it("the returned address comes from the database's id, not from a value the form echoed (a mismatching echo is not trusted)", async () => {
    // The update reports the id it changed; make it differ from the form's echo and the address must follow the database.
    db.rows = [JANE, BOB];
    const fd = new FormData();
    fd.set("client_id", "client-bob"); fd.set("name", "Bob Lee"); fd.set("allergies", "latex"); fd.set("saved_inline", "1"); fd.set("redirectTo", "https://evil.example/x"); fd.set("baseline", JSON.stringify(BASE));
    db.rpcId = "client-bob-stored";
    const r = (await updateClientAction(fd)) as { ok: true; redirectTo: string };
    expect(r.redirectTo).toBe("/clients/client-bob-stored");
    db.rpcId = null;
    const fd2 = new FormData();
    fd2.set("client_id", "client-bob"); fd2.set("name", "Bob Lee"); fd2.set("saved_inline", "1"); fd2.set("redirectTo", "https://evil.example/x"); fd2.set("baseline", JSON.stringify(BASE));
    expect(((await updateClientAction(fd2)) as { redirectTo: string }).redirectTo).toBe("/clients/client-bob");
  });
});
