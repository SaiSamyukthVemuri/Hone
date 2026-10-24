import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 slice 2: staff client create warns about a probable duplicate before
// it inserts. Until now the only guard was the email unique index, so two
// records for one person (no email, or a different one) were created silently.
// The CSV import already treats "same phone" and "same name + date of birth"
// as confident duplicates (lib/import/quick-import.ts matchExisting); staff
// create now asks first, using the same existing fields and no schema.
//
// A warning is advisory: "Save as a new client anyway" resubmits with the
// matched clients' ids. A confirmation covers only the clients it names, so a
// changed form that matches someone else warns again, and (Team L1) EVERY
// probable duplicate is shown and must be confirmed, not only the first.

type Row = {
  id: string; studio_id: string; name: string; phone: string | null; sms_phone: string | null;
  date_of_birth: string | null; archived_at: string | null; normalized_email: string | null;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  inserts: [] as Record<string, unknown>[],
  failSelect: false,
  selects: [] as string[],
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
      const filters: Array<[string, unknown]> = [];
      let limit = Infinity;
      const run = () => {
        if (db.failSelect) return { data: null, error: { code: "57014", message: "synthetic" } };
        const rows = db.rows
          .filter((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v))
          .slice(0, limit)
          .map((r) => ({ id: r.id, name: r.name, archived_at: r.archived_at }));
        return { data: rows, error: null };
      };
      const query = {
        select: (columns: string) => { db.selects.push(columns); return query; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return query; },
        limit: (n: number) => { limit = n; return query; },
        then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
        insert: (row: Record<string, unknown>) => {
          db.inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "new-client" }, error: null }) }) };
        },
      };
      return query;
    },
  }),
}));

import { createClientAction } from "@/app/(app)/clients/new/actions";

const JANE: Row = {
  id: "client-jane", studio_id: "studio-A", name: "Jane Smith", phone: "(604) 555-0199",
  sms_phone: "+16045550199", date_of_birth: "1990-01-02", archived_at: null, normalized_email: null,
};

const JANET: Row = {
  id: "client-janet", studio_id: "studio-A", name: "Janet Lee", phone: null,
  sms_phone: null, date_of_birth: "1985-05-06", archived_at: null, normalized_email: null,
};

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function create(fields: Record<string, string>) {
  try {
    return { result: await createClientAction(form(fields)), redirected: null as string | null };
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (!m) throw err;
    return { result: undefined, redirected: m[1] };
  }
}

beforeEach(() => {
  db.rows = [JANE];
  db.inserts = [];
  db.failSelect = false;
  db.selects = [];
});

describe("HON-58 staff create warns about a probable duplicate before inserting", () => {
  it("same phone in another format: warns, names the existing client, inserts nothing", async () => {
    const { result } = await create({ name: "J. Smith", phone: "604.555.0199" });
    expect(result).toMatchObject({
      ok: false,
      possibleDuplicates: [{ reason: "phone", clientId: "client-jane", clientName: "Jane Smith", archived: false }],
    });
    expect(db.inserts).toHaveLength(0);
  });

  it("same name (spacing and case aside) and same date of birth: warns, inserts nothing", async () => {
    const { result } = await create({ name: "  jane   SMITH ", date_of_birth: "1990-01-02" });
    expect(result).toMatchObject({ ok: false, possibleDuplicates: [{ reason: "name_dob", clientId: "client-jane" }] });
    expect(db.inserts).toHaveLength(0);
  });

  it("an archived match still warns, and says it is archived", async () => {
    db.rows = [{ ...JANE, archived_at: "2026-09-01T00:00:00Z" }];
    const { result } = await create({ name: "Someone", phone: "+1 604 555 0199" });
    expect(result).toMatchObject({ possibleDuplicates: [{ clientId: "client-jane", archived: true }] });
    expect(db.inserts).toHaveLength(0);
  });

  it("same name alone, or same date of birth alone, is not a probable duplicate", async () => {
    expect((await create({ name: "Jane Smith" })).redirected).toBe("/clients/new-client");
    expect((await create({ name: "Jane Smith", date_of_birth: "1991-01-02" })).redirected).toBe("/clients/new-client");
    expect((await create({ name: "Other Person", date_of_birth: "1990-01-02" })).redirected).toBe("/clients/new-client");
    expect(db.inserts).toHaveLength(3);
  });

  it("another studio's client never matches", async () => {
    db.rows = [{ ...JANE, studio_id: "studio-B" }];
    expect((await create({ name: "Jane Smith", phone: "604-555-0199", date_of_birth: "1990-01-02" })).redirected)
      .toBe("/clients/new-client");
  });

  it("'save anyway' with the matched client's id creates the record", async () => {
    const { redirected } = await create({ name: "J. Smith", phone: "604.555.0199", confirm_possible_duplicate: "client-jane" });
    expect(redirected).toBe("/clients/new-client");
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).not.toHaveProperty("confirm_possible_duplicate");
  });

  it("a confirmation for a different client does not cover this match", async () => {
    const { result } = await create({ name: "J. Smith", phone: "604.555.0199", confirm_possible_duplicate: "client-other" });
    expect(result).toMatchObject({ possibleDuplicates: [{ clientId: "client-jane" }] });
    expect(db.inserts).toHaveLength(0);
  });

  it("a failed duplicate read refuses the create rather than claiming there is no duplicate", async () => {
    db.failSelect = true;
    const { result } = await create({ name: "J. Smith", phone: "604.555.0199" });
    expect(result).toEqual({ ok: false, error: "Couldn't save the client. Please try again." });
    expect(db.inserts).toHaveLength(0);
  });

  it("the warning carries only the existing client's id and name, never their phone or date of birth", async () => {
    const { result } = await create({ name: "J. Smith", phone: "604.555.0199" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("555");
    expect(text).not.toContain("1990");
    expect(db.selects.every((s) => s === "id, name, archived_at")).toBe(true);
  });

  it("L1: two different probable duplicates are both shown, once each", async () => {
    db.rows = [JANE, JANET];
    const { result } = await create({ name: "Janet Lee", phone: "604.555.0199", date_of_birth: "1985-05-06" });
    expect(result).toMatchObject({
      ok: false,
      possibleDuplicates: [
        { reason: "phone", clientId: "client-jane" },
        { reason: "name_dob", clientId: "client-janet" },
      ],
    });
    expect(db.inserts).toHaveLength(0);
  });

  it("L1: confirming only the first does not pass the second", async () => {
    db.rows = [JANE, JANET];
    const { result } = await create({
      name: "Janet Lee", phone: "604.555.0199", date_of_birth: "1985-05-06",
      confirm_possible_duplicate: "client-jane",
    });
    expect(result).toMatchObject({ possibleDuplicates: [{ clientId: "client-jane" }, { clientId: "client-janet" }] });
    expect(db.inserts).toHaveLength(0);
  });

  it("L1: confirming every shown duplicate creates the record", async () => {
    db.rows = [JANE, JANET];
    const fd: Record<string, string> = { name: "Janet Lee", phone: "604.555.0199", date_of_birth: "1985-05-06" };
    const f = form(fd);
    f.append("confirm_possible_duplicate", "client-jane");
    f.append("confirm_possible_duplicate", "client-janet");
    await expect(createClientAction(f)).rejects.toThrow("NEXT_REDIRECT:/clients/new-client");
    expect(db.inserts).toHaveLength(1);
  });

  it("L1: one client matching by both phone and name+DOB is shown once", async () => {
    const { result } = await create({ name: "Jane Smith", phone: "604-555-0199", date_of_birth: "1990-01-02" });
    expect((result as { possibleDuplicates: unknown[] }).possibleDuplicates).toHaveLength(1);
  });
});
