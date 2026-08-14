import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B 3E remaining defects, migration 0139:
//  #2  the recurring-rule guard blocks re-enabling / saving an ACTIVE scoped
//      rule whose practitioner is inactive, and blocks assigning any source to
//      an inactive practitioner, while allowing toggle-off / edit-disabled /
//      delete / reassign-to-active / change-to-studio-wide.
//  3E-7 find_scoped_calendar_conflict, resource-aware, deterministic, PII-free.
//  §10  find_recurring_break_conflict, pattern projection, excludes the edited
//      rule's own future occurrences.
//  #1  a practitioner-scoped ALL-DAY block reserves only that practitioner.
// Synthetic Studio B (owner P0 + members P1, P2), timezone pinned to UTC so
// local wall-clock == UTC for deterministic overlap math. Never Willow.

let B: SynthStudio;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!;
const member = () => B.practitioners.find((p) => p.role === "practitioner")!;

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true, timezone = 'UTC', buffer_minutes = 0 where id = $1`,
    [B.studioId],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const setCap = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [B.studioId, v]);
const deactivate = (pid: string) =>
  adminQuery(`update public.practitioners set active = false where id = $1`, [pid]);

// Insert a rule row directly (fires the guard) and return its id.
async function insRule(
  practitionerId: string | null,
  active: boolean,
  days = "{1,2,3,4,5}",
  start = "12:00",
  end = "13:00",
): Promise<{ id: string; code?: string }> {
  try {
    const r = await adminQuery(
      `insert into public.studio_recurring_break_rules
         (id, studio_id, label, days_of_week, start_local_time, end_local_time, active, practitioner_id)
       values ($1,$2,'lunch',$3::int[],$4,$5,$6,$7) returning id`,
      [randomUUID(), B.studioId, days, start, end, active, practitionerId],
    );
    return { id: r.rows[0].id as string };
  } catch (e) {
    return { id: "", code: (e as { code?: string }).code };
  }
}
const updRule = (id: string, set: string, params: unknown[] = []) =>
  adminQuery(`update public.studio_recurring_break_rules set ${set} where id = $1`, [id, ...params])
    .then(() => ({ ok: true as const, code: undefined as string | undefined }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));

const insBlock = (practitionerId: string | null, starts: string, ends: string) =>
  adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
     values ($1,$2,$3,$4,'break',$5) returning id`,
    [randomUUID(), B.studioId, starts, ends, practitionerId],
  ).then((r) => r.rows[0].id as string);

async function insAppointment(practitionerId: string, starts: string, ends: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1,$2,$3,$4,$5,$6,60,0,$6,'confirmed')`,
    [id, B.studioId, B.clientId, practitionerId, starts, ends],
  );
  return id;
}

const conflict = (
  practitionerId: string | null,
  starts: string,
  ends: string,
  exKind: string | null = null,
  exId: string | null = null,
) =>
  adminQuery(
    `select * from public.find_scoped_calendar_conflict($1,$2,$3::timestamptz,$4::timestamptz,$5,$6)`,
    [B.studioId, practitionerId, starts, ends, exKind, exId],
  ).then((r) => r.rows as Array<{ source_kind: string; starts_at: string; ends_at: string; resource_key: string }>);

// ---------------------------------------------------------------------------
describe("0139 defect #2, inactive-practitioner recurring-rule guard", () => {
  it("allows toggle-off, edit-disabled, reassign-to-active, studio-wide, delete; blocks re-enable + save-active + new-assign", async () => {
    const rule = await insRule(P(1), true); // P(1) active at creation
    expect(rule.id).toBeTruthy();
    await deactivate(P(1));

    // ALLOWED: toggle active true -> false
    expect((await updRule(rule.id, "active = false")).ok).toBe(true);
    // ALLOWED: edit label while disabled
    expect((await updRule(rule.id, "label = 'dinner'")).ok).toBe(true);
    // DENIED: re-enable while still assigned to inactive P(1)
    const reEnable = await updRule(rule.id, "active = true");
    expect(reEnable.ok).toBe(false);
    expect(reEnable.code).toBe("23514");
    // DENIED: save an ACTIVE rule still assigned to inactive P(1) (force active back on via a combined save)
    const saveActive = await updRule(rule.id, "active = true, label = 'x'");
    expect(saveActive.code).toBe("23514");
    // ALLOWED: reassign to active P(2) (and enable in the same statement)
    expect((await updRule(rule.id, "practitioner_id = $2, active = true", [P(2)])).ok).toBe(true);
    // ALLOWED: change back to studio-wide
    expect((await updRule(rule.id, "practitioner_id = null")).ok).toBe(true);
    // ALLOWED: delete (guard does not fire on delete)
    expect((await updRule(rule.id, "label = 'y'")).ok).toBe(true);
    await adminQuery(`delete from public.studio_recurring_break_rules where id = $1`, [rule.id]);
  });

  it("blocks assigning ANY new rule (even disabled) to an inactive practitioner", async () => {
    await deactivate(P(2));
    const activeNew = await insRule(P(2), true);
    expect(activeNew.code).toBe("23514");
    const disabledNew = await insRule(P(2), false);
    expect(disabledNew.code).toBe("23514");
    // studio-wide + active-practitioner inserts still succeed
    expect((await insRule(null, true)).id).toBeTruthy();
    expect((await insRule(P(1), true)).id).toBeTruthy();
  });

  it("still blocks a scoped rule while capacity is OFF (42501) on INSERT", async () => {
    await setCap(false);
    expect((await insRule(P(1), true)).code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("0139 3E-7: find_scoped_calendar_conflict is resource-aware + PII-free", () => {
  const S = "2031-06-10T10:00:00Z";
  const E = "2031-06-10T11:00:00Z";

  it("an appointment for P1 never conflicts a P2-only block, but does for a P1 or studio-wide block", async () => {
    const appt = await insAppointment(P(1), S, E);
    expect((await conflict(P(2), S, E))).toHaveLength(0); // B-only block: no false conflict
    const p1 = await conflict(P(1), S, E);
    expect(p1).toHaveLength(1);
    expect(p1[0].source_kind).toBe("appointment");
    expect(p1[0].resource_key).toBe(P(1));
    const wide = await conflict(null, S, E); // ON studio-wide -> every practitioner key
    expect(wide).toHaveLength(1);
    expect(wide[0].source_kind).toBe("appointment");
    // excluding the appointment yields no conflict
    expect(await conflict(P(1), S, E, "appointment", appt)).toHaveLength(0);
    // returned columns are metadata only, no client/service/note fields exist on the row
    expect(Object.keys(p1[0]).sort()).toEqual(["ends_at", "resource_key", "source_kind", "starts_at"]);
  });

  it("returns only source kind/interval/resource_key: never client identity", async () => {
    await insAppointment(P(1), S, E);
    const rows = await conflict(P(1), S, E);
    const row = rows[0] as Record<string, unknown>;
    for (const banned of ["client_id", "client_name", "service", "private_note", "email", "phone"]) {
      expect(row[banned]).toBeUndefined();
    }
  });

  it("dedupes a fanned studio-wide source and returns the earliest deterministically", async () => {
    // Two studio-wide timed blocks -> each fans to all 3 practitioners (same source, 3 rows).
    await insBlock(null, "2031-06-11T09:00:00Z", "2031-06-11T09:30:00Z"); // earlier
    await insBlock(null, "2031-06-11T15:00:00Z", "2031-06-11T15:30:00Z"); // later
    const hit = await conflict(null, "2031-06-11T08:00:00Z", "2031-06-11T16:00:00Z");
    expect(hit).toHaveLength(1); // deduped to ONE source
    expect(new Date(hit[0].starts_at).toISOString()).toBe("2031-06-11T09:00:00.000Z"); // the earliest
  });

  it("Legacy (capacity OFF) matches on the studio resource key", async () => {
    await insAppointment(P(1), S, E);
    await setCap(false); // appt reservation rematerializes to studio_id
    const hit = await conflict(null, S, E); // practitionerId ignored when OFF
    expect(hit).toHaveLength(1);
    expect(hit[0].resource_key).toBe(B.studioId);
  });

  it("is revoked from the browser roles (anon / authenticated get permission denied)", async () => {
    const anon = await asRole("anon", (q) =>
      q(`select * from public.find_scoped_calendar_conflict($1,$2,$3::timestamptz,$4::timestamptz,null,null)`, [
        B.studioId,
        P(1),
        S,
        E,
      ]),
    ).then(() => "ok").catch((e) => (e as { code?: string }).code);
    expect(anon).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("0139 §10: find_recurring_break_conflict projects the pattern + excludes the edited rule", () => {
  // A concrete future weekday within the horizon (UTC studio => local == UTC).
  const soon = new Date(Date.now() + 21 * 86_400_000);
  const dateStr = soon.toISOString().slice(0, 10);
  const dow = soon.getUTCDay(); // 0=Sun..6=Sat, matches Postgres extract(dow)
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const recur = (
    practitionerId: string | null,
    start: string,
    end: string,
    excludeRuleId: string | null = null,
  ) =>
    adminQuery(
      `select * from public.find_recurring_break_conflict($1,$2,$3::int[],$4,$5,$6::date,$7)`,
      [B.studioId, practitionerId, `{${dow}}`, start, end, horizon, excludeRuleId],
    ).then((r) => r.rows as Array<{ source_kind: string; starts_at: string; resource_key: string }>);

  it("projects onto an appointment for the scoped practitioner, but not another", async () => {
    await insAppointment(P(1), `${dateStr}T12:00:00Z`, `${dateStr}T13:00:00Z`);
    const p1 = await recur(P(1), "12:00", "13:00");
    expect(p1).toHaveLength(1);
    expect(p1[0].source_kind).toBe("appointment");
    expect(await recur(P(2), "12:00", "13:00")).toHaveLength(0); // resource-aware
  });

  it("excludes the edited rule's OWN future occurrences", async () => {
    // Materialize a real rule scoped to P(1) at 14:00-15:00 on `dow`.
    const r = await adminQuery(
      `select public.create_recurring_break_rule_and_materialize($1,'lunch',$2::int[],'14:00','15:00',true,$3,$4::date,$5) id`,
      [B.studioId, `{${dow}}`, P(0), horizon, P(1)],
    );
    const ruleId = r.rows[0].id as string;
    // Projecting the same pattern with NO exclusion finds the rule's own occurrence.
    const self = await recur(P(1), "14:00", "15:00");
    expect(self).toHaveLength(1);
    expect(self[0].source_kind).toBe("recurring_break_occurrence");
    // Excluding the edited rule removes the self-collision.
    expect(await recur(P(1), "14:00", "15:00", ruleId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("0139 defect #1: practitioner-scoped ALL-DAY block reserves only that practitioner", () => {
  const DAY_START = "2031-07-14T00:00:00Z"; // UTC studio => local midnight
  const DAY_END = "2031-07-15T00:00:00Z";
  const resKeys = (sourceId: string) =>
    adminQuery(
      `select resource_key from public.studio_calendar_reservations where source_kind='timed_block' and source_id=$1 order by resource_key`,
      [sourceId],
    ).then((r) => (r.rows as Array<{ resource_key: string }>).map((x) => x.resource_key).sort());

  it("an A-scoped all-day block reserves ONLY A; a studio-wide all-day block reserves everyone", async () => {
    const scoped = await insBlock(P(1), DAY_START, DAY_END);
    expect(await resKeys(scoped)).toEqual([P(1)]); // B and C untouched
    const wide = await insBlock(null, "2031-07-16T00:00:00Z", "2031-07-17T00:00:00Z");
    expect(await resKeys(wide)).toEqual([P(0), P(1), P(2)].sort());
  });

  it("Legacy: an all-day block collapses to a single studio-keyed reservation", async () => {
    await setCap(false);
    const wide = await insBlock(null, DAY_START, DAY_END);
    expect(await resKeys(wide)).toEqual([B.studioId]);
  });
});

// ---------------------------------------------------------------------------
describe("0139 §6: full privilege matrix; the readers are no cross-tenant surface", () => {
  const S = "2031-06-10T10:00:00Z";
  const E = "2031-06-10T11:00:00Z";
  // Denied calls pass a DIFFERENT (foreign / random) studio id, proving the
  // denial is at the EXECUTE-privilege layer, a browser role can never use the
  // reader to enumerate ANY studio, not just its own.
  const FOREIGN = randomUUID();
  const callAs = (
    q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null }>,
    studioId: string,
  ) =>
    q(
      `select * from public.find_scoped_calendar_conflict($1,$2,$3::timestamptz,$4::timestamptz,null,null)`,
      [studioId, P(1), S, E],
    );
  const code = (p: Promise<unknown>) =>
    p.then(() => "ok").catch((e) => (e as { code?: string }).code ?? "err");

  it("anon is denied (42501) even for a foreign studio id", async () => {
    expect(await code(asRole("anon", (q) => callAs(q, FOREIGN)))).toBe("42501");
  });
  it("an authenticated OWNER is denied (42501)", async () => {
    expect(await code(asUser(owner().userId, (q) => callAs(q, FOREIGN)))).toBe("42501");
    // ...and denied for their OWN studio too, the browser path never reaches it.
    expect(await code(asUser(owner().userId, (q) => callAs(q, B.studioId)))).toBe("42501");
  });
  it("an authenticated MEMBER is denied (42501)", async () => {
    expect(await code(asUser(member().userId, (q) => callAs(q, FOREIGN)))).toBe("42501");
  });
  it("service_role is allowed (foreign studio → 0 rows, no error)", async () => {
    const r = await asRole("service_role", (q) => callAs(q, FOREIGN));
    expect(r.rowCount).toBe(0);
  });
  it("the recurring reader has the identical privilege posture (anon denied, service_role allowed)", async () => {
    const callRecur = (
      q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null }>,
    ) =>
      q(
        `select * from public.find_recurring_break_conflict($1,$2,$3::int[],'12:00','13:00',$4::date,null)`,
        [FOREIGN, P(1), "{1}", "2032-01-01"],
      );
    expect(await code(asRole("anon", callRecur))).toBe("42501");
    expect(await code(asUser(member().userId, callRecur))).toBe("42501");
    expect((await asRole("service_role", callRecur)).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("0139 item #1: the migration's transaction is atomic (no partial apply)", () => {
  it("after apply, both readers exist and are NOT executable by public/anon/authenticated", async () => {
    const fns = await adminQuery(
      `select proname from pg_proc
        where proname in ('find_scoped_calendar_conflict','find_recurring_break_conflict')
        order by proname`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([
      "find_recurring_break_conflict",
      "find_scoped_calendar_conflict",
    ]);
    // has_function_privilege for each browser role is false; service_role true.
    const priv = await adminQuery(
      `select
         has_function_privilege('anon','public.find_scoped_calendar_conflict(uuid,uuid,timestamptz,timestamptz,text,uuid)','execute') anon,
         has_function_privilege('authenticated','public.find_scoped_calendar_conflict(uuid,uuid,timestamptz,timestamptz,text,uuid)','execute') auth,
         has_function_privilege('service_role','public.find_scoped_calendar_conflict(uuid,uuid,timestamptz,timestamptz,text,uuid)','execute') svc`,
    );
    expect(priv.rows[0]).toMatchObject({ anon: false, auth: false, svc: true });
  });

  it("an induced failure inside the transaction leaves NO function and NO leaked privilege", async () => {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      // Model the migration shape: define a SECURITY DEFINER reader + revoke, then
      // FAIL before completion. Postgres DDL is transactional, so the rollback must
      // leave neither the function nor any privilege change, exactly why 0139
      // wraps create+revoke in one begin/commit.
      await c.query("begin");
      await c.query(
        `create or replace function public.__atomic_probe_0139() returns int
           language sql security definer set search_path = pg_catalog, pg_temp as 'select 1'`,
      );
      await c.query(`revoke execute on function public.__atomic_probe_0139() from public`);
      // Induced failure BEFORE the transaction completes.
      await expect(c.query("select 1 / 0")).rejects.toMatchObject({ code: "22012" });
      await c.query("rollback");
      // Neither the function nor its (attempted) privilege change survived.
      const exists = await c.query(
        `select 1 from pg_proc where proname = '__atomic_probe_0139'`,
      );
      expect(exists.rowCount).toBe(0);
    } finally {
      await c.end();
    }
  });
});
