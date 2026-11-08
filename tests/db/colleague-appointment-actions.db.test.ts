import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { adminQuery, asRole, closePool, resolveLocalDbUrl, seedMember, seedStudio } from "./helpers/harness";

// HON-44 D1-D4 (Sam, 2 Nov): a practitioner MAY cancel, mark no-show, edit notes and send aftercare for a COLLEAGUE's
// appointment inside their own studio. No assignee gate. This file pins that decision (positive: same-studio colleague
// allowed; negative: other studio, a non-member, a deactivated member, and anon/authenticated API roles refused; the owner is the
// positive control. A real receptionist (studio_receptionists row) refusal is NOT tested here: add it when the desk fixtures exist) and, when
// HONE_HELD_FIX_SQL is set, proves the held accountability SQL (note versions, no-show reason, audit of what changed).
// No fee or payment row may ever be created by any of the four. Time is relative to now(), never a literal.

const tokenHash = () => createHash("sha256").update(randomUUID()).digest("hex");

type Seed = { status: "confirmed" | "completed"; whenHours: number; practitionerId: string | null; notes?: string | null };
let slot = 0;
async function seedAppointment(studioId: string, clientId: string, s: Seed): Promise<string> {
  // distinct 30-minute windows per appointment: the studio-wide overlap exclusion rejects overlaps
  const off = s.whenHours + 3 * slot++ * Math.sign(s.whenHours || 1);
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status,
        cancellation_token_hash, buffer_minutes_snapshot, blocked_ends_at, notes)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($5::text || ' hours')::interval,
             now() + ($5::text || ' hours')::interval + interval '30 minutes', 30, $6, $4,
             15, now() + ($5::text || ' hours')::interval + interval '45 minutes', $7)
     returning id`,
    [studioId, s.practitionerId, clientId, tokenHash(), off, s.status, s.notes ?? null],
  );
  return r.rows[0].id as string;
}

async function fixture() {
  const own = await seedStudio("d14a");
  const colleague = await seedMember(own, "d14b"); // an active practitioner of the same studio, NOT the assignee
  const assignee = await seedMember(own, "d14c");
  const other = await seedStudio("d14x"); // a different studio, with its own owner
  return { own, colleague, assignee, other };
}

const feeRows = async (studioId: string) => {
  const q = async (t: string) =>
    Number((await adminQuery(`select count(*)::int n from public.${t} where studio_id = $1`, [studioId])).rows[0].n);
  return [
    await q("payment_charge_attempts"),
    await q("manual_fee_charge_attempts"),
    await q("stripe_charge_attempts"),
    await q("appointment_settlements"),
  ];
};

const audit = async (appointmentId: string, action: string) =>
  (
    await adminQuery(
      `select actor_type, actor_id, details, created_at from public.appointment_audit
        where appointment_id = $1 and action = $2 order by created_at`,
      [appointmentId, action],
    )
  ).rows;

afterAll(async () => {
  await closePool();
});

describe("D1 cancel: a same-studio colleague may cancel; others may not", () => {
  it("colleague cancels another practitioner's future appointment; the audit names the colleague", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 48, practitionerId: f.assignee.practitionerId });
    const before = await feeRows(f.own.studioId);
    const r = await adminQuery(`select public.practitioner_cancel_appointment($1,$2,$3,$4) as r`, [id, f.own.studioId, f.colleague.practitionerId, "client asked"]);
    expect(r.rows[0].r).toBe("cancelled");
    const a = await audit(id, "cancelled");
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(f.colleague.practitionerId);
    expect(a[0].details.reason).toBe("client asked");
    expect(await feeRows(f.own.studioId)).toEqual(before);
  });

  it("another studio's practitioner naming this studio is refused and nothing changes", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 72, practitionerId: f.assignee.practitionerId });
    const r = await adminQuery(`select public.practitioner_cancel_appointment($1,$2,$3,$4) as r`, [id, f.own.studioId, f.other.practitionerId, "x"]);
    expect(r.rows[0].r).toBe("not_authorized");
    expect((await adminQuery(`select status from public.appointments where id=$1`, [id])).rows[0].status).toBe("confirmed");
  });
});

describe("D2 no-show: a same-studio colleague may mark it, and it creates no fee or payment row", () => {
  it("colleague marks a colleague's past appointment; audit has the actor; no fee/charge/settlement row appears", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: -6, practitionerId: f.assignee.practitionerId });
    const before = await feeRows(f.own.studioId);
    const r = await adminQuery(`select public.mark_appointment_no_show($1,$2,$3) as r`, [id, f.own.studioId, f.colleague.practitionerId]);
    expect(r.rows[0].r).toBe("marked");
    const a = await audit(id, "marked_no_show");
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(f.colleague.practitionerId);
    expect(await feeRows(f.own.studioId)).toEqual(before);
  });

  it("another studio's practitioner is refused", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: -9, practitionerId: f.assignee.practitionerId });
    const r = await adminQuery(`select public.mark_appointment_no_show($1,$2,$3) as r`, [id, f.own.studioId, f.other.practitionerId]);
    expect(r.rows[0].r).toBe("not_authorized");
  });
});

describe("D3 notes: a same-studio colleague may edit; a non-member may not", () => {
  it("colleague edits; a non-member user id (no membership at all) is refused", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 96, practitionerId: f.assignee.practitionerId, notes: "first" });
    const ok = await adminQuery(`select public.set_appointment_notes($1,$2,$3,$4) as r`, [id, f.own.studioId, f.colleague.userId, "second"]);
    expect(ok.rows[0].r).toBe("ok");
    const no = await adminQuery(`select public.set_appointment_notes($1,$2,$3,$4) as r`, [id, f.own.studioId, randomUUID(), "third"]);
    expect(no.rows[0].r).toBe("not_a_member");
    const crossStudio = await adminQuery(`select public.set_appointment_notes($1,$2,$3,$4) as r`, [id, f.own.studioId, f.other.userId, "fourth"]);
    expect(crossStudio.rows[0].r).toBe("not_a_member");
    expect((await adminQuery(`select notes from public.appointments where id=$1`, [id])).rows[0].notes).toBe("second");
  });
});

describe("D4 aftercare: a same-studio colleague may claim a send for a completed appointment; others may not", () => {
  it("colleague claims; another studio's practitioner is not authorised", async () => {
    const f = await fixture();
    const id = await seedAppointment(f.own.studioId, f.own.clientId, { status: "completed", whenHours: -12, practitionerId: f.assignee.practitionerId });
    const bad = await adminQuery(`select * from public.claim_postcare_send($1,$2,$3,false)`, [id, f.own.studioId, f.other.practitionerId]);
    expect(bad.rows[0].result).toBe("not_authorized");
    const good = await adminQuery(`select * from public.claim_postcare_send($1,$2,$3,false)`, [id, f.own.studioId, f.colleague.practitionerId]);
    expect(good.rows[0].result).toBe("claimed");
  });
});

describe("the owner (positive control) may do all four on a colleague's appointment", () => {
  it("cancel, no-show, notes and aftercare claim each succeed for the owner as actor", async () => {
    const f = await fixture();
    const fut = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 150, practitionerId: f.assignee.practitionerId });
    const past = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: -30, practitionerId: f.assignee.practitionerId });
    const done = await seedAppointment(f.own.studioId, f.own.clientId, { status: "completed", whenHours: -33, practitionerId: f.assignee.practitionerId });
    const noted = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 160, practitionerId: f.assignee.practitionerId, notes: "o1" });
    expect((await adminQuery(`select public.practitioner_cancel_appointment($1,$2,$3,'o') as r`, [fut, f.own.studioId, f.own.practitionerId])).rows[0].r).toBe("cancelled");
    expect((await adminQuery(`select public.mark_appointment_no_show($1,$2,$3) as r`, [past, f.own.studioId, f.own.practitionerId])).rows[0].r).toBe("marked");
    expect((await adminQuery(`select public.set_appointment_notes($1,$2,$3,'o2') as r`, [noted, f.own.studioId, f.own.userId])).rows[0].r).toBe("ok");
    expect((await adminQuery(`select * from public.claim_postcare_send($1,$2,$3,false)`, [done, f.own.studioId, f.own.practitionerId])).rows[0].result).toBe("claimed");
  });
});

// The command resolves the CURRENT active row. A colleague who was deactivated after the app session began is refused exactly like a
// non-member, for every one of the four; nothing changes.
describe("a DEACTIVATED member of the same studio is refused for all four", () => {
  it("cancel, no-show, notes and aftercare claim are refused after deactivation; state is unchanged", async () => {
    const f = await fixture();
    const fut = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 170, practitionerId: f.assignee.practitionerId });
    const past = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: -36, practitionerId: f.assignee.practitionerId });
    const done = await seedAppointment(f.own.studioId, f.own.clientId, { status: "completed", whenHours: -39, practitionerId: f.assignee.practitionerId });
    const noted = await seedAppointment(f.own.studioId, f.own.clientId, { status: "confirmed", whenHours: 180, practitionerId: f.assignee.practitionerId, notes: "keep" });
    // control: while active, the same colleague IS accepted on one of them (so the later refusal is the deactivation)
    expect((await adminQuery(`select public.set_appointment_notes($1,$2,$3,'while active') as r`, [noted, f.own.studioId, f.colleague.userId])).rows[0].r).toBe("ok");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.colleague.practitionerId]);
    expect((await adminQuery(`select public.practitioner_cancel_appointment($1,$2,$3,'x') as r`, [fut, f.own.studioId, f.colleague.practitionerId])).rows[0].r).toBe("not_authorized");
    expect((await adminQuery(`select public.mark_appointment_no_show($1,$2,$3) as r`, [past, f.own.studioId, f.colleague.practitionerId])).rows[0].r).toBe("not_authorized");
    expect((await adminQuery(`select public.set_appointment_notes($1,$2,$3,'after') as r`, [noted, f.own.studioId, f.colleague.userId])).rows[0].r).toBe("not_a_member");
    expect((await adminQuery(`select * from public.claim_postcare_send($1,$2,$3,false)`, [done, f.own.studioId, f.colleague.practitionerId])).rows[0].result).toBe("not_authorized");
    const st = async (id: string) => (await adminQuery(`select status, notes from public.appointments where id=$1`, [id])).rows[0];
    expect((await st(fut)).status).toBe("confirmed");
    expect((await st(past)).status).toBe("confirmed");
    expect((await st(noted)).notes).toBe("while active");
  });
});

describe("D1-D4 are not callable from the API roles", () => {
  const calls: Array<[string, string]> = [
    ["practitioner_cancel_appointment", "$1::uuid,$2::uuid,$3::uuid,'x'"],
    ["mark_appointment_no_show", "$1::uuid,$2::uuid,$3::uuid"],
    ["set_appointment_notes", "$1::uuid,$2::uuid,$3::uuid,'x'"],
    ["claim_postcare_send", "$1::uuid,$2::uuid,$3::uuid,false"],
  ];
  it.each(calls.flatMap(([fn, args]) => (["anon", "authenticated"] as const).map((role) => [fn, role, args] as const)))(
    "%s is refused for %s (42501)",
    async (fn, role, args) => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await expect(asRole(role, (q) => q(`select public.${fn}(${args})`, ids))).rejects.toMatchObject({ code: "42501" });
    },
  );
});

// ---- the held accountability SQL (unnumbered). Applied inside a rolled-back transaction on an isolated stack only. ----
const HELD = process.env.HONE_HELD_D1D4_SQL;
describe.skipIf(!HELD)("HON-44 D1-D4 held accountability SQL (rolled back)", () => {
  it("note versions, no-show reason, change recorded in audit, aftercare audit; no fee row; API roles still refused", async () => {
    const f = await fixture();
    const sql = readFileSync(HELD!, "utf8").replace(/^\s*begin;\s*$/im, "").replace(/^\s*commit;\s*$/im, "");
    const pool = new pg.Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
    const c = await pool.connect();
    try {
      const mk = async (s: Seed) => {
        const r = await c.query(
          `insert into public.appointments
             (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status,
              cancellation_token_hash, buffer_minutes_snapshot, blocked_ends_at, notes)
           values (gen_random_uuid(), $1, $2, $3, now() + ($5::text || ' hours')::interval,
                   now() + ($5::text || ' hours')::interval + interval '30 minutes', 30, $6, $4,
                   15, now() + ($5::text || ' hours')::interval + interval '45 minutes', $7) returning id`,
          [f.own.studioId, s.practitionerId, f.own.clientId, tokenHash(), s.whenHours + 3 * slot++ * Math.sign(s.whenHours || 1), s.status, s.notes ?? null],
        );
        return r.rows[0].id as string;
      };
      await c.query("begin");
      try {
        await c.query(sql);

        // D3: three edits keep two prior versions; blank-to-text and unchanged text keep none
        const n = await mk({ status: "confirmed", whenHours: 120, practitionerId: f.assignee.practitionerId, notes: "v-original" });
        const edit = (t: string) => c.query(`select public.set_appointment_notes($1,$2,$3,$4) as r`, [n, f.own.studioId, f.colleague.userId, t]);
        expect((await edit("v-second")).rows[0].r).toBe("ok");
        expect((await edit("v-second")).rows[0].r).toBe("ok"); // unchanged: no new version
        expect((await edit("v-third")).rows[0].r).toBe("ok");
        const vs = (await c.query(`select version, body, changed_by_practitioner_id from public.appointment_note_versions where appointment_id=$1 order by version`, [n])).rows;
        expect(vs.map((x) => [x.version, x.body])).toEqual([[1, "v-original"], [2, "v-second"]]);
        expect(vs.every((x) => x.changed_by_practitioner_id === f.colleague.practitionerId)).toBe(true);
        const na = (await c.query(`select details from public.appointment_audit where appointment_id=$1 and action='notes_corrected' order by created_at`, [n])).rows;
        expect(JSON.stringify(na)).not.toContain("v-original"); // audit still never carries note text
        expect(na.map((x) => x.details.previous_version)).toEqual([1, null, 2]);

        // versions are append-only and not writable by API roles
        await c.query("savepoint u");
        await expect(c.query(`update public.appointment_note_versions set body='x' where appointment_id=$1`, [n])).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint u");
        await c.query("savepoint a");
        await c.query("set local role authenticated");
        await expect(c.query(`insert into public.appointment_note_versions (appointment_id, studio_id, version, body, changed_by_practitioner_id) values ($1,$2,99,'x',$3)`, [n, f.own.studioId, f.colleague.practitionerId])).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint a");
        await c.query("reset role");

        // D2: reason recorded; too long refused; old three-argument call still works; no fee row
        const ns1 = await mk({ status: "confirmed", whenHours: -15, practitionerId: f.assignee.practitionerId });
        const ns2 = await mk({ status: "confirmed", whenHours: -18, practitionerId: f.assignee.practitionerId });
        const ns3 = await mk({ status: "confirmed", whenHours: -21, practitionerId: f.assignee.practitionerId });
        const feeBefore = (await c.query(`select (select count(*) from public.payment_charge_attempts where studio_id=$1) + (select count(*) from public.manual_fee_charge_attempts where studio_id=$1) + (select count(*) from public.stripe_charge_attempts where studio_id=$1) + (select count(*) from public.appointment_settlements where studio_id=$1) as n`, [f.own.studioId])).rows[0].n;
        expect((await c.query(`select public.mark_appointment_no_show($1,$2,$3,$4) as r`, [ns1, f.own.studioId, f.colleague.practitionerId, "  did not arrive  "])).rows[0].r).toBe("marked");
        expect((await c.query(`select public.mark_appointment_no_show($1,$2,$3,$4) as r`, [ns2, f.own.studioId, f.colleague.practitionerId, "x".repeat(501)])).rows[0].r).toBe("reason_too_long");
        expect((await c.query(`select public.mark_appointment_no_show($1,$2,$3) as r`, [ns3, f.own.studioId, f.colleague.practitionerId])).rows[0].r).toBe("marked");
        const d = (await c.query(`select details, actor_id from public.appointment_audit where appointment_id=$1 and action='marked_no_show'`, [ns1])).rows[0];
        expect(d.actor_id).toBe(f.colleague.practitionerId);
        expect(d.details).toMatchObject({ reason: "did not arrive", from_status: "confirmed", to_status: "no_show" });
        expect((await c.query(`select status from public.appointments where id=$1`, [ns2])).rows[0].status).toBe("confirmed");
        const feeAfter = (await c.query(`select (select count(*) from public.payment_charge_attempts where studio_id=$1) + (select count(*) from public.manual_fee_charge_attempts where studio_id=$1) + (select count(*) from public.stripe_charge_attempts where studio_id=$1) + (select count(*) from public.appointment_settlements where studio_id=$1) as n`, [f.own.studioId])).rows[0].n;
        expect(feeAfter).toBe(feeBefore);

        // D1: the audit now records what changed
        const cx = await mk({ status: "confirmed", whenHours: 140, practitionerId: f.assignee.practitionerId });
        expect((await c.query(`select public.practitioner_cancel_appointment($1,$2,$3,'r') as r`, [cx, f.own.studioId, f.colleague.practitionerId])).rows[0].r).toBe("cancelled");
        expect((await c.query(`select details from public.appointment_audit where appointment_id=$1 and action='cancelled'`, [cx])).rows[0].details).toMatchObject({ from_status: "confirmed", to_status: "cancelled", reason: "r" });

        // D4: a claim and a settlement each leave an audit row; the claim names the practitioner
        const pc = await mk({ status: "completed", whenHours: -24, practitionerId: f.assignee.practitionerId });
        const claim = (await c.query(`select * from public.claim_postcare_send($1,$2,$3,false)`, [pc, f.own.studioId, f.colleague.practitionerId])).rows[0];
        expect(claim.result).toBe("claimed");
        const st = (await c.query(`select * from public.settle_postcare_send($1,$2,$3,true,false)`, [pc, f.own.studioId, claim.claimed_at])).rows[0];
        expect(st.result).toBe("settled");
        const pa = (await c.query(`select action, actor_type, actor_id, details from public.appointment_audit where appointment_id=$1 and action like 'postcare_send_%' order by created_at, action`, [pc])).rows;
        expect(pa.map((x) => x.action)).toEqual(["postcare_send_claimed", "postcare_send_settled"]);
        expect(pa[0].actor_id).toBe(f.colleague.practitionerId);
        expect(pa[1].details.outcome).toBe("sent");

        // API roles still cannot call the replaced no-show function
        await c.query("savepoint b");
        await c.query("set local role authenticated");
        await expect(c.query(`select public.mark_appointment_no_show($1,$2,$3,'x')`, [ns3, f.own.studioId, f.colleague.practitionerId])).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint b");
        await c.query("reset role");
      } finally {
        await c.query("rollback");
      }
    } finally {
      c.release();
      await pool.end();
    }
  });
});
