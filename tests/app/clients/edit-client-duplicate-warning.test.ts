import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58, Team review of #1084 (I1): editing a client could turn the record
// into a probable duplicate (a phone or date of birth changed to another
// client's) with no warning. The edit path now runs #1084's matcher
// (lib/clients/possible-duplicate.ts, unchanged) when the edit changes an
// identity field (name, phone or date of birth), never counts the client
// being edited, and saves only when every probable duplicate was confirmed.
// An edit that leaves those fields alone is not re-warned about a duplicate
// that already existed.

type Row = {
  id: string; studio_id: string; name: string; phone: string | null; sms_phone: string | null;
  date_of_birth: string | null; archived_at: string | null;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  updates: [] as Record<string, unknown>[],
  failMatcher: false,
  failStored: false,
  selects: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "prac-1" }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      expect(table).toBe("clients");
      const filters: Array<[string, unknown]> = [];
      let columns = "";
      let limit = Infinity;
      const matching = () => db.rows.filter((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v));
      const project = (r: Row) => Object.fromEntries(
        columns.split(",").map((c) => c.trim()).map((c) => [c, (r as Record<string, unknown>)[c]]),
      );
      const query = {
        select: (c: string) => { columns = c; db.selects.push(c); return query; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return query; },
        limit: (n: number) => { limit = n; return query; },
        maybeSingle: async () => {
          if (db.failStored && columns !== "id") return { data: null, error: { code: "57014" } };
          const r = matching()[0];
          return { data: r ? project(r) : null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (db.failMatcher) return Promise.resolve({ data: null, error: { code: "57014" } }).then(resolve);
          return Promise.resolve({ data: matching().slice(0, limit).map(project), error: null }).then(resolve);
        },
        update: (row: Record<string, unknown>) => {
          db.updates.push(row);
          const u = { eq: () => u, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
          return u;
        },
      };
      return query;
    },
  }),
}));

import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

const JANE: Row = {
  id: "client-jane", studio_id: "studio-A", name: "Jane Smith", phone: "(604) 555-0199",
  sms_phone: "+16045550199", date_of_birth: "1990-01-02", archived_at: null,
};
const BOB: Row = {
  id: "client-bob", studio_id: "studio-A", name: "Bob Lee", phone: "778-555-0100",
  sms_phone: "+17785550100", date_of_birth: "1980-03-04", archived_at: null,
};

async function edit(fields: Record<string, string>, confirm: string[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const id of confirm) fd.append("confirm_possible_duplicate", id);
  try {
    return { result: await updateClientAction(fd), redirected: null as string | null };
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (!m) throw err;
    return { result: undefined, redirected: m[1] };
  }
}

const bobAs = (over: Record<string, string>) => ({
  client_id: "client-bob", name: "Bob Lee", phone: "778-555-0100", date_of_birth: "1980-03-04", ...over,
});

beforeEach(() => {
  db.rows = [JANE, BOB];
  db.updates = [];
  db.failMatcher = false;
  db.failStored = false;
  db.selects = [];
});

describe("HON-58 I1: an edit that creates a probable duplicate warns before saving", () => {
  it("a phone changed to another client's phone warns, names them, and saves nothing", async () => {
    const { result } = await edit(bobAs({ phone: "604.555.0199" }));
    expect(result).toMatchObject({
      ok: false,
      possibleDuplicates: [{ reason: "phone", clientId: "client-jane", clientName: "Jane Smith", archived: false }],
    });
    expect(db.updates).toHaveLength(0);
  });

  it("a date of birth (and name) changed to match another client warns", async () => {
    const { result } = await edit(bobAs({ name: "jane  smith", date_of_birth: "1990-01-02" }));
    expect(result).toMatchObject({ possibleDuplicates: [{ reason: "name_dob", clientId: "client-jane" }] });
    expect(db.updates).toHaveLength(0);
  });

  it("the client being edited is never its own duplicate", async () => {
    // A name change runs the check, and the phone read returns Jane's own row.
    const { redirected } = await edit({ client_id: "client-jane", name: "Janie Smith", phone: "604 555 0199", date_of_birth: "1990-01-02" });
    expect(redirected).toBe("/clients/client-jane");
    expect(db.updates).toHaveLength(1);
    expect(db.selects).toContain("id, name, archived_at");
  });

  it("an edit that leaves name, phone and date of birth alone is not re-warned about an existing duplicate", async () => {
    db.rows = [JANE, { ...BOB, phone: "(604) 555-0199", sms_phone: "+16045550199" }];
    const { redirected } = await edit(bobAs({ phone: "(604) 555-0199", address: "new address" }));
    expect(redirected).toBe("/clients/client-bob");
    expect(db.updates).toHaveLength(1);
  });

  it("confirming every shown duplicate saves the edit", async () => {
    const { redirected } = await edit(bobAs({ phone: "604.555.0199" }), ["client-jane"]);
    expect(redirected).toBe("/clients/client-bob");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).not.toHaveProperty("confirm_possible_duplicate");
  });

  it("a confirmation naming a different client does not cover the match", async () => {
    const { result } = await edit(bobAs({ phone: "604.555.0199" }), ["client-other"]);
    expect(result).toMatchObject({ possibleDuplicates: [{ clientId: "client-jane" }] });
    expect(db.updates).toHaveLength(0);
  });

  it("a failed duplicate read refuses the save", async () => {
    db.failMatcher = true;
    const { result } = await edit(bobAs({ phone: "604.555.0199" }));
    expect(result).toEqual({ ok: false, error: "Couldn't save the client. Please try again." });
    expect(db.updates).toHaveLength(0);
  });

  it("a failed read of the stored record refuses the save", async () => {
    db.failStored = true;
    const { result } = await edit(bobAs({ phone: "604.555.0199" }));
    expect(result).toEqual({ ok: false, error: "Couldn't save the client. Please try again." });
    expect(db.updates).toHaveLength(0);
  });

  it("the warning carries only the other client's id and name, never their phone or date of birth", async () => {
    const { result } = await edit(bobAs({ phone: "604.555.0199" }));
    const text = JSON.stringify(result);
    expect(text).not.toContain("555");
    expect(text).not.toContain("1990");
  });
});
