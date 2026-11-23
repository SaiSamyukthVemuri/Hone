import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0374: the database no longer returns a client's stored name to a receptionist. The ACCEPTANCE test, on a real migrated
// database, by DIRECT calls to the three read functions (what a signed-in person can do outside the app). Synthetic
// fixtures only: distinctive stored names that appear in no contact field, a preferred name distinct from the stored one,
// (a whitespace-only preferred name cannot exist: clients_preferred_name_shape refuses it, which a case below pins). Every assertion on a name is a boolean: a name is never printed or snapshotted.
// It runs twice, with the legal-name switch OFF and ON, because the switch must not change any of it.

const STORED = ["Zorblatt", "Quillfeather", "Vexmoor", "Tillgard", "Wimbrel", "Oakhaven", "Yarrowby", "Pennick", "Fallowmere", "Thistledown"];
const MARK = "Name on file";
const DIR = "select * from public.receptionist_client_directory($1::uuid, $2::text, null, $3::text, 0, 25)";
const CAL = "select * from public.receptionist_calendar_v2($1::uuid, now() - interval '1 day', now() + interval '30 days')";
const CON = "select * from public.receptionist_client_contacts_v2($1::uuid, $2::text, 50)";

let A: SeededStudio;
let B: SeededStudio;
const ids: Record<"c0" | "c1" | "c2" | "c3" | "c4", string> = {} as never;
const who = {} as Record<"receptionist" | "otherStudio" | "inactive" | "practitioner" | "stranger", string>;
let spareAppt = "";

async function authUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}
async function desk(studioId: string, userId: string, active: boolean) {
  await adminQuery("insert into public.studio_receptionists (studio_id, user_id, display_name, active, deactivated_at) values ($1,$2,'Synthetic Front Desk',$3,$4)", [studioId, userId, active, active ? null : new Date().toISOString()]);
}
async function client(id: string, name: string, preferred: string | null, phone: string, email: string) {
  await adminQuery("insert into public.clients (id, studio_id, name, preferred_name, phone, email) values ($1,$2,$3,$4,$5,$6)", [id, A.studioId, name, preferred, phone, email]);
}
async function appt(clientId: string, startsInDays: number): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4, now() + ($5 || ' days')::interval, now() + ($5 || ' days')::interval + interval '1 hour', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [id, A.studioId, A.practitionerId, clientId, String(startsInDays)],
  );
  return id;
}

type Outcome = { rows: Record<string, unknown>[] } | { code: string; message: string };
const call = async (uid: string | "anon", sql: string, params: unknown[]): Promise<Outcome> => {
  const run = uid === "anon" ? asRole("anon", (q) => q(sql, params)) : asUser(uid, (q) => q(sql, params));
  return run.then(
    (r) => ({ rows: r.rows as Record<string, unknown>[] }),
    (e: { code?: string; message?: string }) => ({ code: e.code ?? "unknown", message: String(e.message ?? "") }),
  );
};
const rowsOf = (o: Outcome) => ("rows" in o ? o.rows : []);
const hasStored = (v: unknown) => { const t = JSON.stringify(v); return STORED.some((s) => t.includes(s)); };
const dir = (q: string | null = null, sort: string | null = "name", uid = who.receptionist) => call(uid, DIR, [A.studioId, q, sort]);
const con = (q: string | null = null, uid = who.receptionist) => call(uid, CON, [A.studioId, q]);
const cal = (uid = who.receptionist) => call(uid, CAL, [A.studioId]);

beforeAll(async () => {
  A = await seedStudio("name-rule-a");
  B = await seedStudio("name-rule-b");
  who.practitioner = (await seedMember(A, "name-rule-prac")).userId;
  who.stranger = await authUser("name-rule-stranger");
  who.receptionist = await authUser("name-rule-desk");
  who.inactive = await authUser("name-rule-inactive");
  who.otherStudio = await authUser("name-rule-other");
  await desk(A.studioId, who.receptionist, true);
  await desk(A.studioId, who.inactive, false);
  await desk(B.studioId, who.otherStudio, true);
  // c1 and c3 have NO usable preferred name. Their ids sort the opposite way to their stored names (Wimbrel < Zorblatt),
  // so an ordering by stored name would put c3 first and an ordering by id puts c1 first.
  const [low, high] = [randomUUID(), randomUUID()].sort();
  ids.c0 = A.clientId;
  await adminQuery("update public.clients set name = $2, phone = '+1 555 0100', email = 'c0@harness.local' where id = $1", [ids.c0, "Fallowmere Thistledown"]);
  ids.c1 = low; await client(ids.c1, "Zorblatt Quillfeather", null, "+1 555 0111", "c1@harness.local");
  ids.c2 = randomUUID(); await client(ids.c2, "Vexmoor Tillgard", "Bean", "+1 555 0112", "c2@harness.local");
  ids.c3 = high; await client(ids.c3, "Wimbrel Oakhaven", null, "+1 555 0113", "c3@harness.local");
  ids.c4 = randomUUID(); await client(ids.c4, "Yarrowby Pennick", "100% Pat", "+1 555 0114", "c4@harness.local");
  for (const [i, c] of [ids.c0, ids.c1, ids.c2, ids.c3, ids.c4].entries()) await appt(c, 2 + i);
  spareAppt = await appt(ids.c1, 20);
});
afterAll(closePool);

describe.each([["OFF", false], ["ON", true]] as const)("legal-name switch %s", (_label, switchOn) => {
  beforeAll(async () => {
    await adminQuery(
      "insert into public.studio_legal_name_access (studio_id, receptionist_access) values ($1, $2) on conflict (studio_id) do update set receptionist_access = excluded.receptionist_access",
      [A.studioId, switchOn],
    );
  });

  describe("fixture constraint", () => {
    it("a whitespace-only preferred name cannot be stored, so 'no usable preferred name' means none", async () => {
      await expect(adminQuery("update public.clients set preferred_name = '   ' where id = $1", [ids.c3])).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("who may call the three functions directly", () => {
    it("this studio's receptionist is answered by all three", async () => {
      for (const o of [await dir(), await cal(), await con()]) expect("rows" in o).toBe(true);
    });
    it.each([
      ["another studio's receptionist", () => who.otherStudio],
      ["an inactive receptionist of this studio", () => who.inactive],
      ["a practitioner who is not a receptionist", () => who.practitioner],
      ["a stranger", () => who.stranger],
      ["anon", () => "anon" as const],
    ])("%s is refused by all three", async (_n, actor) => {
      for (const o of [await call(actor(), DIR, [A.studioId, null, "name"]), await call(actor(), CAL, [A.studioId]), await call(actor(), CON, [A.studioId, null])]) {
        expect("code" in o && o.code).toBe("42501");
      }
    });
  });

  describe("the stored name is returned by none of them", () => {
    it("whole serialised responses carry no stored name, for every accepted sort value and the default, and every row reads as the marker or a preferred name", async () => {
      for (const sort of ["name", "next", null]) {
        const o = await dir(null, sort);
        expect(hasStored(o), `directory sort ${String(sort)}`).toBe(false);
        expect(rowsOf(o).length, `directory sort ${String(sort)} is not vacuous`).toBe(5);
      }
      const c = await cal();
      expect(hasStored(c), "calendar").toBe(false);
      expect(rowsOf(c).length, "calendar: one appointment each plus the spare").toBe(6);
      const k = await con();
      expect(hasStored(k), "contacts").toBe(false);
      expect(rowsOf(k).length).toBe(5);
      for (const r of [...rowsOf(await dir()), ...rowsOf(c), ...rowsOf(k)]) {
        expect([MARK, "Bean", "100% Pat"].includes(String(r.display_name)), "display is the marker or a preferred name").toBe(true);
      }
    });

    it("name_on_file is true exactly when there is no usable preferred name (none)", async () => {
      const byId = new Map(rowsOf(await dir()).map((r) => [r.client_id, r]));
      for (const id of [ids.c0, ids.c1, ids.c3]) expect(byId.get(id), id).toMatchObject({ display_name: MARK, name_on_file: true });
      expect(byId.get(ids.c2)).toMatchObject({ display_name: "Bean", name_on_file: false });
      expect(byId.get(ids.c4)).toMatchObject({ display_name: "100% Pat", name_on_file: false });
      const calByClient = new Map(rowsOf(await cal()).map((r) => [r.client_id, r]));
      expect(calByClient.get(ids.c3)).toMatchObject({ display_name: MARK, name_on_file: true });
      expect(calByClient.get(ids.c2)).toMatchObject({ display_name: "Bean", name_on_file: false });
    });

    it("the same shape of columns as before (same signature, same column names)", async () => {
      expect(Object.keys(rowsOf(await dir())[0])).toEqual(["client_id", "display_name", "name_on_file", "phone", "email", "next_appointment_at", "last_visit_on", "intake_state", "consent_signed", "total_count"]);
      expect(Object.keys(rowsOf(await con())[0])).toEqual(["client_id", "display_name", "phone", "email", "name_on_file"]);
      expect(Object.keys(rowsOf(await cal())[0])).toEqual(["appointment_id", "starts_at", "ends_at", "status", "practitioner_id", "practitioner_display_name", "practitioner_color", "service_id", "service_name", "client_id", "display_name", "name_on_file", "duration_minutes", "studio_timezone"]);
    });
  });

  describe("search never reaches the stored name", () => {
    it("a stored-name substring finds nothing in the directory or the contacts, including behind a preferred name; the marker words find nothing", async () => {
      for (const term of ["Zorblatt", "quillfeather", "Vexmoor", "Wimbrel", "Oakhaven", "Yarrowby", "Fallowmere", "Zorblatt Quillfeather", MARK, "Name on", "on file", "file"]) {
        expect(rowsOf(await dir(term)).length, `directory ${term.length} chars`).toBe(0);
        expect(rowsOf(await con(term)).length, `contacts ${term.length} chars`).toBe(0);
      }
    });

    it("positive controls: a preferred name, an email and a phone still find the client (Q2)", async () => {
      expect(rowsOf(await dir("bean")).map((r) => r.client_id)).toEqual([ids.c2]);
      expect(rowsOf(await con("bean")).map((r) => r.client_id)).toEqual([ids.c2]);
      expect(rowsOf(await dir("c1@harness")).map((r) => r.client_id)).toEqual([ids.c1]);
      expect(rowsOf(await con("555 0113")).map((r) => r.client_id)).toEqual([ids.c3]);
      // and a client found by contact detail still reads as the marker, never the stored name
      expect(rowsOf(await dir("c1@harness"))[0]).toMatchObject({ display_name: MARK, name_on_file: true });
    });

    it("LIKE characters are literal: %% and __ match nobody, a literal % in a preferred name matches only literally", async () => {
      for (const term of ["%%", "__", "\\\\", "_%"]) {
        expect(rowsOf(await dir(term)).length, `directory ${term}`).toBe(0);
        expect(rowsOf(await con(term)).length, `contacts ${term}`).toBe(0);
      }
      expect(rowsOf(await dir("0%")).map((r) => r.client_id)).toEqual([ids.c4]);
      expect(rowsOf(await con("0%")).map((r) => r.client_id)).toEqual([ids.c4]);
    });

    it("the minimum query length and the page caps are unchanged", async () => {
      const short = await dir("a");
      expect("code" in short && short.code).toBe("22023");
      const shortC = await con("a");
      expect("code" in shortC && shortC.code).toBe("22023");
      const deep = await call(who.receptionist, "select * from public.receptionist_client_directory($1::uuid, null, null, 'name', 190, 25)", [A.studioId]);
      expect("code" in deep && deep.code).toBe("22023");
    });
  });

  describe("order never follows the stored name", () => {
    const noPreferred = () => [ids.c0, ids.c1, ids.c3].sort();
    it("every sort value and the default: clients with a preferred name first by that name, the rest by id", async () => {
      const expected = [ids.c4, ids.c2, ...noPreferred()];
      expect(rowsOf(await dir(null, "name")).map((r) => r.client_id)).toEqual(expected);
      expect(rowsOf(await dir(null, null)).map((r) => r.client_id)).toEqual(expected);
      // 'next' orders by the next appointment (c0 .. c4 are booked in that order), then the same name-free tie-break.
      expect(rowsOf(await dir(null, "next")).map((r) => r.client_id)).toEqual([ids.c0, ids.c1, ids.c2, ids.c3, ids.c4]);
      expect(rowsOf(await con(null)).map((r) => r.client_id)).toEqual(expected);
    });
    it("the two clients with no preferred name come back in id order although their stored names sort the other way (non-vacuity)", async () => {
      expect(ids.c1 < ids.c3).toBe(true);
      const order = rowsOf(await dir(null, "name")).map((r) => r.client_id);
      expect(order.indexOf(ids.c1)).toBeLessThan(order.indexOf(ids.c3));
      expect("Wimbrel" < "Zorblatt").toBe(true);
    });
    it("the schedule orders by time", async () => {
      const times = rowsOf(await cal()).map((r) => new Date(String(r.starts_at)).getTime());
      expect(times).toEqual([...times].sort((x, y) => x - y));
    });
  });

  describe("the other receptionist commands return no client name either", () => {
    it("create, move and cancel, called as the receptionist, carry no stored name in a response or an error", async () => {
      const when = new Date(Date.now() + 40 * 86_400_000).toISOString();
      const outcomes = [
        await call(who.receptionist, "select * from public.receptionist_create_appointment($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz)", [A.studioId, A.practitionerId, ids.c1, randomUUID(), when]),
        await call(who.receptionist, "select * from public.receptionist_move_appointment($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6::timestamptz)", [A.studioId, spareAppt, A.practitionerId, when, when, when]),
        await call(who.receptionist, "select public.receptionist_cancel_appointment($1::uuid, $2::uuid, 'test') as r", [A.studioId, spareAppt]),
        await call(who.receptionist, "select * from public.receptionist_booking_options($1::uuid)", [A.studioId]),
        await call(who.receptionist, "select * from public.receptionist_calendar_closures($1::uuid, now(), now() + interval '30 days')", [A.studioId]),
        await call(who.receptionist, "select public.receptionist_studio_timezone($1::uuid) as tz", [A.studioId]),
      ];
      for (const [i, o] of outcomes.entries()) {
        expect("rows" in o || "code" in o, `command ${i} answered`).toBe(true);
        expect(hasStored(o), `command ${i}`).toBe(false);
      }
      // A cancelled spare must not have left a name anywhere a later read could return it.
      expect(hasStored(await cal())).toBe(false);
    });
  });
});

describe("the tables behind the functions stay closed to a receptionist", () => {
  it("with no practitioner row, a receptionist reads zero rows from every public table that has a studio_id, except its OWN receptionist row", async () => {
    const { rows } = await adminQuery(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.column_name = 'studio_id' order by 1`,
    );
    const tables = rows.map((r: { table_name: string }) => r.table_name);
    expect(tables.length, "the catalog lists the studio tables").toBeGreaterThan(20);
    expect(tables).toEqual(expect.arrayContaining(["clients", "appointments", "client_legal_identities", "studio_receptionists"]));
    for (const t of ["clients", "appointments"]) {
      const n = await adminQuery(`select count(*)::int as n from public."${t}" where studio_id = $1`, [A.studioId]);
      expect(n.rows[0].n, `${t} is not empty for the studio (non-vacuity)`).toBeGreaterThan(0);
    }
    const open: string[] = [];
    for (const t of tables) {
      const o = await call(who.receptionist, `select count(*)::int as n from public."${t}"`, []);
      const n = "rows" in o ? Number(o.rows[0].n) : 0; // a privilege error is a closed table
      const allowed = t === "studio_receptionists" ? 1 : 0;
      if (n !== allowed) open.push(t);
    }
    expect(open).toEqual([]);
  });
});
