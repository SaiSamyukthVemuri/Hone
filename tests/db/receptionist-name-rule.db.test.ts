import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// 0280 receptionist name rule. A receptionist sees the preferred name, otherwise the words
// "Name on file"; the stored name (which may be a legal name) reaches no payload, search, sort or count.
// Proved on the real migrated database with a real receptionist JWT. Synthetic values only.

const LABEL = "Name on file";
let a: SeededStudio;
let desk: string;
const ids: Record<string, string> = {};

async function seedDesk(studio: SeededStudio): Promise<string> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `name-rule-${userId.slice(0, 8)}@harness.local`]);
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)", [studio.studioId, userId]);
  return userId;
}
async function addClient(key: string, id: string, name: string, preferred: string | null, phone: string | null): Promise<void> {
  await adminQuery("insert into public.clients(id,studio_id,name,preferred_name,phone) values ($1,$2,$3,$4,$5)", [id, a.studioId, name, preferred, phone]);
  ids[key] = id;
}
const dir = (q: string | null = null, sort = "name") =>
  asUser(desk, (x) => x(`select * from public.receptionist_client_directory($1,$2,null,$3,0,25)`, [a.studioId, q, sort]));
const hits = async (q: string) => (await dir(q)).rows.map((r) => r.client_id as string);

beforeAll(async () => {
  a = await seedStudio("name-rule-a");
  desk = await seedDesk(a);
  // The seeded client is out of the way: archive it so only the clients below are in the directory.
  await adminQuery("update public.clients set archived_at = now() where id = $1", [a.clientId]);
  // Stored-name order is Abe < Zed; id order is the OPPOSITE (Zed's id sorts first). An order that follows
  // the stored name would put Abe first; the rule puts the unlabelled clients in id order.
  // Ids are generated per run (fixed ids collide on a re-run and with other suites on a shared stack); the two
  // unlabelled ids are sorted so Zed's keeps sorting first (lowercase uuid text sorts like the uuid type).
  const [lowId, highId] = [randomUUID(), randomUUID()].sort();
  await addClient("zed", lowId, "Zed Omegastored", null, "+1 555 0301");
  await addClient("abe", highId, "Abe Alphastored", null, "+1 555 0302");
  await addClient("carol", randomUUID(), "Carol Legalname", "Caz", "+1 555 0303");
});

afterAll(async () => {
  await closePool();
});

describe("directory", () => {
  it("shows the preferred name, else the literal label; the stored name is in no returned value", async () => {
    const r = await dir();
    const byId = new Map(r.rows.map((x) => [x.client_id, x]));
    expect(byId.get(ids.carol)).toMatchObject({ display_name: "Caz", name_on_file: false });
    expect(byId.get(ids.abe)).toMatchObject({ display_name: LABEL, name_on_file: true });
    expect(byId.get(ids.zed)).toMatchObject({ display_name: LABEL, name_on_file: true });
    const all = JSON.stringify(r.rows);
    for (const stored of ["Omegastored", "Alphastored", "Legalname"]) expect(all).not.toContain(stored);
    expect(r.fields.map((f) => f.name)).toEqual([
      "client_id", "display_name", "name_on_file", "phone", "email",
      "next_appointment_at", "last_visit_on", "intake_state", "consent_signed", "total_count",
    ]);
  });
  it("search never matches a stored name (positive controls: preferred name, phone and the owner's own view DO match)", async () => {
    for (const term of ["Omegastored", "Alphastored", "Legalname", "Abe", "Zed", "Carol"]) expect(await hits(term)).toEqual([]);
    expect(await hits("Caz")).toEqual([ids.carol]);
    expect(await hits("555 0302")).toEqual([ids.abe]);
    // The label is not a search key either: it would otherwise list every unlabelled client.
    expect(await hits("Name on")).toEqual([]);
    // Control: the stored name IS in the table, so the finder is not simply broken.
    const stored = await adminQuery("select count(*)::int n from public.clients where studio_id=$1 and name ilike '%Omegastored%'", [a.studioId]);
    expect(stored.rows[0].n).toBe(1);
  });
  it("order follows the shown value then id, never the stored name; total_count counts the searched set", async () => {
    const r = await dir();
    // 'caz' sorts before 'name on file'; the two unlabelled clients tie and fall back to id (Zed first, the reverse of stored order).
    expect(r.rows.map((x) => x.client_id)).toEqual([ids.carol, ids.zed, ids.abe]);
    expect(r.rows.every((x) => Number(x.total_count) === 3)).toBe(true);
    const one = await dir("555 0302");
    expect(one.rows.map((x) => Number(x.total_count))).toEqual([1]);
    expect((await dir("Alphastored")).rows).toEqual([]);
  });
});

describe("schedule", () => {
  it("receptionist_calendar_v2 carries the preferred name or the label, never the stored name", async () => {
    const insert = (key: string, at: string) =>
      adminQuery(
        `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
         values (gen_random_uuid(), $1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
        [a.studioId, a.practitionerId, ids[key], at],
      );
    await insert("abe", "2031-03-04T15:00:00Z");
    await insert("carol", "2031-03-04T17:00:00Z");
    const r = await asUser(desk, (x) => x(`select * from public.receptionist_calendar_v2($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')`, [a.studioId]));
    expect(r.rows.map((x) => [x.display_name, x.name_on_file])).toEqual([[LABEL, true], ["Caz", false]]);
    const all = JSON.stringify(r.rows);
    for (const stored of ["Omegastored", "Alphastored", "Legalname"]) expect(all).not.toContain(stored);
  });
});

describe("contacts finder v2 is closed", () => {
  it("no role can execute it, and a real receptionist JWT is refused at the privilege layer", async () => {
    const fn = "public.receptionist_client_contacts_v2(uuid,text,integer)";
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await adminQuery("select has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok).toBe(false);
    }
    await expect(asUser(desk, (x) => x(`select * from public.receptionist_client_contacts_v2($1,null,25)`, [a.studioId]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("cancellation reason cap", () => {
  let slot = 0;
  async function future(): Promise<string> {
    const id = randomUUID();
    const day = 30 + slot++;
    await adminQuery(
      `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values ($1, $2, $3, $4, now() + make_interval(days => $5), now() + make_interval(days => $5, hours => 1), 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
      [id, a.studioId, a.practitionerId, ids.carol, day],
    );
    return id;
  }
  const cancel = (appt: string, reason: string | null) =>
    asUser(desk, (x) => x(`select public.receptionist_cancel_appointment($1,$2,$3) as r`, [a.studioId, appt, reason]));
  const status = async (appt: string) => (await adminQuery("select status from public.appointments where id=$1", [appt])).rows[0].status;

  it("501 characters is refused and changes nothing; 500 and NULL are accepted (controls)", async () => {
    const long = await future();
    await expect(cancel(long, "x".repeat(501))).rejects.toMatchObject({ code: "22023" });
    expect(await status(long)).toBe("confirmed");
    const edge = await future();
    expect((await cancel(edge, "y".repeat(500))).rows[0].r).toBe("cancelled");
    expect(await status(edge)).toBe("cancelled");
    const nul = await future();
    expect((await cancel(nul, null)).rows[0].r).toBe("cancelled");
  });
  it("a non-receptionist caller is still refused before the length is looked at", async () => {
    const stranger = randomUUID();
    await adminQuery("insert into auth.users(id,email) values ($1,$2)", [stranger, `stranger-${stranger.slice(0, 8)}@harness.local`]);
    const appt = await future();
    const r = await asUser(stranger, (x) => x(`select public.receptionist_cancel_appointment($1,$2,$3) as r`, [a.studioId, appt, "x".repeat(900)]));
    expect(r.rows[0].r).toBe("not_authorized");
  });
});
