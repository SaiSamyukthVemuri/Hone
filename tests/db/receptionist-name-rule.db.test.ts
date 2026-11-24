import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";
import { closeOlderContactCommands, reopenOlderContactCommands } from "./helpers/older-contact-commands";

// 0380 (replacing 0374's rule): a receptionist sees the PREFERRED name, otherwise the REGULAR client name, and the words
// 'Name on file' ONLY when both are blank. The ACCEPTANCE test, on a real migrated database, by DIRECT calls to the three read
// functions (what a signed-in person can do outside the app). Synthetic fixtures only: distinctive regular names that appear
// in no contact field, preferred names distinct from them, a both-blank client, and a distinct LEGAL identity in its own table.
// (A whitespace-only preferred name cannot exist: clients_preferred_name_shape refuses it, which a case below pins; a
// whitespace-only REGULAR name can, and reads as blank.) Every assertion on a name is a boolean: a name is never printed.
// It runs twice, with the legal-name switch OFF and ON, because the switch must not change any of it.

// Regular names that a receptionist SEES (no preferred name), and ones that are HIDDEN behind a preferred name.
const SHOWN = ["Zorblatt", "Quillfeather", "Wimbrel", "Oakhaven", "Fallowmere", "Thistledown", "Hollin", "Carrow"];
const HIDDEN = ["Vexmoor", "Tillgard", "Yarrowby", "Pennick"];
const LEGAL = ["Zzlegalgiven", "Zzlegalfamily", "Zzlegalbean"];
const MARK = "Name on file";
const DIR = "select * from public.receptionist_client_directory($1::uuid, $2::text, null, $3::text, 0, 25)";
const CAL = "select * from public.receptionist_calendar_v2($1::uuid, now() - interval '1 day', now() + interval '30 days')";
const CON = "select * from public.receptionist_client_contacts_v2($1::uuid, $2::text, 50)";

let A: SeededStudio;
let B: SeededStudio;
const ids: Record<"c0" | "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7", string> = {} as never;
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
// A blank regular name cannot be created by any normal path: clients_identity_guard refuses it on insert and on update. Such a row can
// exist only if it predates the guard, so the fixture suspends the guard for ONE multi-statement command (one implicit transaction) on
// this owned stack and puts it back. The ids are generated here, never user input.
async function legacyBlankClient(id: string, name: string, phone: string, email: string) {
  await adminQuery(
    `alter table public.clients disable trigger clients_identity_guard;
     insert into public.clients (id, studio_id, name, preferred_name, phone, email) values ('${id}', '${A.studioId}', '${name}', null, '${phone}', '${email}');
     alter table public.clients enable trigger clients_identity_guard;`,
  );
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
const has = (v: unknown, words: string[]) => { const t = JSON.stringify(v); return words.some((s) => t.includes(s)); };
const hasHidden = (v: unknown) => has(v, HIDDEN);
const hasLegal = (v: unknown) => has(v, LEGAL);
const dir = (q: string | null = null, sort: string | null = "name", uid = who.receptionist) => call(uid, DIR, [A.studioId, q, sort]);
const con = (q: string | null = null, uid = who.receptionist) => call(uid, CON, [A.studioId, q]);
const cal = (uid = who.receptionist) => call(uid, CAL, [A.studioId]);

beforeAll(async () => {
  await reopenOlderContactCommands();
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
  // c0, c1, c3 and c6 have only a regular name; c2 and c4 have a preferred name that differs from theirs; c5 and c7 are BOTH
  // blank (a whitespace regular name, no preferred name) and share the displayed words, so their order is decided by id.
  const [low, high] = [randomUUID(), randomUUID()].sort();
  ids.c0 = A.clientId;
  await adminQuery("update public.clients set name = $2, phone = '+1 555 0100', email = 'c0@harness.local' where id = $1", [ids.c0, "Fallowmere Thistledown"]);
  ids.c1 = low; await client(ids.c1, "Zorblatt Quillfeather", null, "+1 555 0111", "c1@harness.local");
  ids.c2 = randomUUID(); await client(ids.c2, "Vexmoor Tillgard", "Bean", "+1 555 0112", "c2@harness.local");
  ids.c3 = high; await client(ids.c3, "Wimbrel Oakhaven", null, "+1 555 0113", "c3@harness.local");
  ids.c4 = randomUUID(); await client(ids.c4, "Yarrowby Pennick", "100% Pat", "+1 555 0114", "c4@harness.local");
  const [blankLow, blankHigh] = [randomUUID(), randomUUID()].sort();
  ids.c5 = blankHigh; await legacyBlankClient(ids.c5, "   ", "+1 555 0115", "c5@harness.local");
  ids.c6 = randomUUID(); await client(ids.c6, "Hollin Carrow", null, "+1 555 0116", "c6@harness.local");
  ids.c7 = blankLow; await legacyBlankClient(ids.c7, "", "+1 555 0117", "c7@harness.local");
  // A distinct LEGAL identity, in its own table, for a client with a preferred name and for one with only a regular name.
  await adminQuery("insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, legal_single_name, source) values ($1,$2,'Zzlegalbean','Zzlegalbean',false,'staff_entry')", [ids.c2, A.studioId]);
  await adminQuery("insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, legal_single_name, source) values ($1,$2,'Zzlegalgiven','Zzlegalfamily',false,'staff_entry')", [ids.c6, A.studioId]);
  for (const [i, c] of [ids.c0, ids.c1, ids.c2, ids.c3, ids.c4, ids.c5, ids.c6, ids.c7].entries()) await appt(c, 2 + i);
  spareAppt = await appt(ids.c1, 20);
});
afterAll(async () => {
  await closeOlderContactCommands(); // 0381 closed them; reopened in beforeAll only to prove the reviewed bodies
  await closePool();
});

describe.each([["OFF", false], ["ON", true]] as const)("legal-name switch %s", (_label, switchOn) => {
  beforeAll(async () => {
    await adminQuery(
      "insert into public.studio_legal_name_access (studio_id, receptionist_access) values ($1, $2) on conflict (studio_id) do update set receptionist_access = excluded.receptionist_access",
      [A.studioId, switchOn],
    );
  });

  describe("fixture constraint", () => {
    it("neither a whitespace-only preferred name nor a blank regular name can be stored by a normal path; a both-blank client is a legacy row", async () => {
      await expect(adminQuery("insert into public.clients (id, studio_id, name) values (gen_random_uuid(), $1, '  ')", [A.studioId])).rejects.toMatchObject({ code: "23514" });
      expect((await adminQuery("select tgenabled from pg_trigger where tgname = 'clients_identity_guard'")).rows[0]).toMatchObject({ tgenabled: "O" });
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

  describe("what a receptionist is shown: preferred, else regular, else Name on file only when both are blank", () => {
    const EXPECT = () => ({
      [ids.c0]: ["Fallowmere Thistledown", false], [ids.c1]: ["Zorblatt Quillfeather", false], [ids.c2]: ["Bean", false], [ids.c3]: ["Wimbrel Oakhaven", false],
      [ids.c4]: ["100% Pat", false], [ids.c5]: [MARK, true], [ids.c6]: ["Hollin Carrow", false], [ids.c7]: [MARK, true],
    } as Record<string, [string, boolean]>);
    it("all three functions show exactly that, and name_on_file is true only for the both-blank clients", async () => {
      const want = EXPECT();
      const sets: Array<[string, Outcome]> = [["directory", await dir()], ["contacts", await con()], ["calendar", await cal()]];
      for (const [label, o] of sets) {
        const rows = rowsOf(o).filter((r) => String(r.client_id) in want);
        const byId = new Map(rows.map((r) => [String(r.client_id), r]));
        for (const [id, [shown, onFile]] of Object.entries(want)) {
          expect(byId.get(id), `${label} ${id}`).toMatchObject({ display_name: shown, name_on_file: onFile });
        }
      }
    });
    it("whole serialised responses carry no HIDDEN regular name and no legal identity, for every sort and the default, and are not vacuous", async () => {
      for (const sort of ["name", "next", null]) {
        const o = await dir(null, sort);
        expect(hasHidden(o), `directory sort ${String(sort)} hidden`).toBe(false);
        expect(hasLegal(o), `directory sort ${String(sort)} legal`).toBe(false);
        expect(rowsOf(o).length, `directory sort ${String(sort)} is not vacuous`).toBe(8);
      }
      const c = await cal();
      const k = await con();
      expect(rowsOf(c).length, "calendar: one appointment each plus the spare").toBe(9);
      expect(rowsOf(k).length).toBe(8);
      for (const [label, o] of [["calendar", c], ["contacts", k]] as const) {
        expect(hasHidden(o), `${label} hidden`).toBe(false);
        expect(hasLegal(o), `${label} legal`).toBe(false);
      }
      // positive control: the regular names that ARE displayed do appear (so the scan is not blind)
      expect(has(await dir(), SHOWN)).toBe(true);
    });
    it("the legal switch and a legal identity never change what is shown: a client with a legal identity shows its preferred or regular name", async () => {
      const byId = new Map(rowsOf(await dir()).map((r) => [String(r.client_id), r]));
      expect(byId.get(ids.c2)).toMatchObject({ display_name: "Bean" });
      expect(byId.get(ids.c6)).toMatchObject({ display_name: "Hollin Carrow" });
    });
    it("the same shape of columns as before (same signature, same column names)", async () => {
      expect(Object.keys(rowsOf(await dir())[0])).toEqual(["client_id", "display_name", "name_on_file", "phone", "email", "next_appointment_at", "last_visit_on", "intake_state", "consent_signed", "total_count"]);
      expect(Object.keys(rowsOf(await con())[0])).toEqual(["client_id", "display_name", "phone", "email", "name_on_file"]);
      expect(Object.keys(rowsOf(await cal())[0])).toEqual(["appointment_id", "starts_at", "ends_at", "status", "practitioner_id", "practitioner_display_name", "practitioner_color", "service_id", "service_name", "client_id", "display_name", "name_on_file", "duration_minutes", "studio_timezone"]);
    });
  });

  describe("search matches the DISPLAYED name, the email and the phone, and nothing else", () => {
    it("a displayed regular name is found by its first name or its surname, in any case", async () => {
      for (const [term, id] of [["Zorblatt", ids.c1], ["quillfeather", ids.c1], ["THISTLEDOWN", ids.c0], ["Fallowmere", ids.c0], ["Carrow", ids.c6], ["hollin car", ids.c6]] as const) {
        expect(rowsOf(await dir(term)).map((r) => r.client_id), `directory ${term}`).toEqual([id]);
        expect(rowsOf(await con(term)).map((r) => r.client_id), `contacts ${term}`).toEqual([id]);
      }
    });
    it("a regular name HIDDEN behind a preferred name finds nothing", async () => {
      for (const term of ["Vexmoor", "tillgard", "Vexmoor Tillgard", "Yarrowby", "Pennick", "Yarrowby Pennick"]) {
        expect(rowsOf(await dir(term)).length, `directory ${term.length} chars`).toBe(0);
        expect(rowsOf(await con(term)).length, `contacts ${term.length} chars`).toBe(0);
      }
    });
    it("a legal name finds nothing (a legal identity is in its own table and is never searched)", async () => {
      for (const term of ["Zzlegalgiven", "zzlegalfamily", "Zzlegalbean", "Zzlegal"]) {
        expect(rowsOf(await dir(term)).length, `directory ${term}`).toBe(0);
        expect(rowsOf(await con(term)).length, `contacts ${term}`).toBe(0);
      }
    });
    it("the fixed words find nothing, but a both-blank client is still found by its email and phone", async () => {
      for (const term of [MARK, "Name on", "on file", "file"]) {
        expect(rowsOf(await dir(term)).length, `directory ${term}`).toBe(0);
        expect(rowsOf(await con(term)).length, `contacts ${term}`).toBe(0);
      }
      expect(rowsOf(await dir("c5@harness")).map((r) => r.client_id)).toEqual([ids.c5]);
      expect(rowsOf(await con("555 0117")).map((r) => r.client_id)).toEqual([ids.c7]);
      expect(rowsOf(await dir("c5@harness"))[0]).toMatchObject({ display_name: MARK, name_on_file: true });
    });
    it("positive controls: a preferred name, an email and a phone still find the client, exactly as before", async () => {
      expect(rowsOf(await dir("bean")).map((r) => r.client_id)).toEqual([ids.c2]);
      expect(rowsOf(await con("bean")).map((r) => r.client_id)).toEqual([ids.c2]);
      expect(rowsOf(await dir("c1@harness")).map((r) => r.client_id)).toEqual([ids.c1]);
      expect(rowsOf(await con("555 0113")).map((r) => r.client_id)).toEqual([ids.c3]);
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

  describe("order is the displayed name, then id", () => {
    it("every sort value and the default: by the displayed name (case-insensitive), the two both-blank clients last-tied by id; the finder agrees", async () => {
      const blank = [ids.c5, ids.c7].sort();
      // 100% Pat, Bean, Fallowmere Thistledown, Hollin Carrow, Name on file (x2, by id), Wimbrel Oakhaven, Zorblatt Quillfeather
      const expected = [ids.c4, ids.c2, ids.c0, ids.c6, ...blank, ids.c3, ids.c1];
      expect(rowsOf(await dir(null, "name")).map((r) => r.client_id)).toEqual(expected);
      expect(rowsOf(await dir(null, null)).map((r) => r.client_id)).toEqual(expected);
      expect(rowsOf(await con(null)).map((r) => r.client_id)).toEqual(expected);
      // 'next' orders by the next appointment (c0 .. c7 are booked in that order), then the same tie-break.
      expect(rowsOf(await dir(null, "next")).map((r) => r.client_id)).toEqual([ids.c0, ids.c1, ids.c2, ids.c3, ids.c4, ids.c5, ids.c6, ids.c7]);
    });
    it("the two both-blank clients come back in id order (non-vacuity: their ids sort the opposite way to creation order)", async () => {
      expect(ids.c7 < ids.c5).toBe(true);
      const order = rowsOf(await dir(null, "name")).map((r) => r.client_id);
      expect(order.indexOf(ids.c7)).toBe(order.indexOf(ids.c5) - 1);
    });
    it("the schedule orders by time", async () => {
      const times = rowsOf(await cal()).map((r) => new Date(String(r.starts_at)).getTime());
      expect(times).toEqual([...times].sort((x, y) => x - y));
    });
  });

  describe("the other receptionist commands return no client name either", () => {
    it("create, move and cancel, called as the receptionist, carry no hidden regular name and no legal identity in a response or an error", async () => {
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
        expect(hasHidden(o) || hasLegal(o), `command ${i}`).toBe(false);
      }
      // A cancelled spare must not have left a hidden name anywhere a later read could return it.
      expect(hasHidden(await cal()) || hasLegal(await cal())).toBe(false);
    });
  });
});

describe("a whitespace-only PREFERRED name (a legacy row the shape check now refuses) reads as blank, so the regular name is shown", () => {
  it("shows and finds the regular name, and says it has a name; the shape check is put back as it was", async () => {
    const id = randomUUID();
    const DROP = "alter table public.clients drop constraint clients_preferred_name_shape;";
    const RESTORE = "alter table public.clients add constraint clients_preferred_name_shape check (preferred_name is null or (length(preferred_name) >= 1 and length(preferred_name) <= 200 and preferred_name = btrim(preferred_name)));";
    // One implicit transaction: drop the check, insert the legacy row. The check is restored (validated) after the row is deleted.
    await adminQuery(`${DROP} insert into public.clients (id, studio_id, name, preferred_name, phone, email) values ('${id}', '${A.studioId}', 'Whitepref Regular', '   ', '+1 555 0118', 'c8@harness.local');`);
    try {
      const row = rowsOf(await dir("whitepref")).find((r) => r.client_id === id);
      expect(row, "directory finds the client by the regular name").toMatchObject({ display_name: "Whitepref Regular", name_on_file: false });
      expect(rowsOf(await con("whitepref")).map((r) => r.client_id)).toEqual([id]);
    } finally {
      await adminQuery("delete from public.clients where id = $1", [id]);
      await adminQuery(RESTORE);
    }
    await expect(adminQuery("insert into public.clients (id, studio_id, name, preferred_name) values (gen_random_uuid(), $1, 'Shape Check', '   ')", [A.studioId])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the tables behind the functions stay closed to a receptionist", () => {
  async function openTables(): Promise<string[]> {
    const { rows } = await adminQuery(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.column_name = 'studio_id' order by 1`,
    );
    const tables = rows.map((r: { table_name: string }) => r.table_name);
    expect(tables.length, "the catalog lists the studio tables").toBeGreaterThan(20);
    expect(tables).toEqual(expect.arrayContaining(["clients", "appointments", "client_legal_identities", "studio_receptionists"]));
    for (const t of ["clients", "appointments", "client_legal_identities"]) {
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
    return open;
  }
  const setSwitch = (on: boolean) => adminQuery(
    "insert into public.studio_legal_name_access (studio_id, receptionist_access) values ($1, $2) on conflict (studio_id) do update set receptionist_access = excluded.receptionist_access",
    [A.studioId, on],
  );
  it("with the legal-name switch OFF and no practitioner row, a receptionist reads zero rows from every public table that has a studio_id, except its OWN receptionist row (a legal identity row exists, so this is not vacuous)", async () => {
    await setSwitch(false);
    expect(await openTables()).toEqual([]);
  });
  it("with the legal-name switch ON the ONLY other table a receptionist can read is client_legal_identities (0266, by design, the owner's switch); nothing else opens", async () => {
    await setSwitch(true);
    try {
      expect(await openTables()).toEqual(["client_legal_identities"]);
    } finally {
      await setSwitch(false);
    }
  });
});
