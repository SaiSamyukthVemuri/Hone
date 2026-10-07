// 0206 — SMS-00 DELIVERY FOUNDATION, against a real database.
//
// What these cases pin:
//
//   * the ledger is reachable ONLY through its four service_role commands --
//     no browser role holds a table privilege or an EXECUTE grant;
//   * a waitlist invitation can be texted at most once, only while it is live,
//     only by its own studio, and only when the studio has switched it on;
//   * a settle records what the provider answered and nothing settles twice;
//   * delivery-status callbacks only move forward, never cross attempts, and
//     resolve an ambiguous settle into the provider's own answer;
//   * the invitation claim holds the invitation row, so a lifecycle command
//     racing it is either seen (not_live) or waits for it -- never missed;
//   * the reminder claim validates status and window and claims in one
//     transaction: a refusal spends no attempt, and a cancel or move racing
//     it is waited for and then seen.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  adminQuery,
  asRole,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const sid = () => `SM${randomUUID().replace(/-/g, "")}`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

let A: SeededStudio;
let B: SeededStudio;

beforeAll(async () => {
  A = await seedStudio("sms-ledger-a");
  B = await seedStudio("sms-ledger-b");
});
afterAll(async () => {
  await closePool();
});

// Each appointment gets its own future slot: the studio-wide overlap exclusion
// constraint is real and would refuse a second row in the same interval.
let slot = 0;
async function seedAppointment(s: SeededStudio): Promise<string> {
  const hoursOut = 30 + slot++ * 2;
  const r = await q<{ id: string }>(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4::text || ' hours')::interval,
             now() + ($4::text || ' hours')::interval + interval '45 minutes',
             45, 'confirmed', $5)
     returning id`,
    [s.studioId, s.practitionerId, s.clientId, String(hoursOut), hash64()],
  );
  return r[0]!.id;
}

type EntrySms = {
  phone?: string | null;
  consent?: boolean;
  optedOut?: boolean;
  verified?: boolean;
};

/** An entry and one invitation, written directly: these cases are about the
 *  SMS commands, not about how an invitation comes to exist. */
async function seedInvitation(
  s: SeededStudio,
  opts: EntrySms & { lifecycle?: "live" | "lapsed" | "released" } = {},
): Promise<{ invitationId: string; entryId: string }> {
  const entryId = randomUUID();
  const phone = opts.phone === undefined ? "+16475550123" : opts.phone;
  await q(
    `insert into public.new_client_waitlist_entries
       (id, studio_id, name, email, phone, status,
        claimed_at, claimed_by_practitioner_id, invited_at,
        sms_consent_at, sms_consent_source, sms_consent_text_version,
        sms_opted_out_at, sms_opt_out_source, mobile_verified_at)
     values ($1, $2, 'Prospect', $3, $4, 'invited', now(), $5, now(),
             case when $6 then now() end,
             case when $6 then 'public_form' end,
             case when $6 then 'waitlist_sms_operational_v1' end,
             case when $7 then now() end,
             case when $7 then 'twilio_stop' end,
             case when $8 then now() end)`,
    [
      entryId,
      s.studioId,
      `p-${entryId.slice(0, 8)}@harness.local`,
      phone,
      s.practitionerId,
      opts.consent ?? true,
      opts.optedOut ?? false,
      opts.verified ?? true,
    ],
  );
  const invitationId = randomUUID();
  const lifecycle = opts.lifecycle ?? "live";
  await q(
    `insert into public.new_client_waitlist_invitations
       (id, studio_id, entry_id, token_hash, issued_at, expires_at,
        issued_by_practitioner_id, released_at)
     values ($1, $2, $3, $4,
             case when $6 = 'lapsed' then now() - interval '3 days' else now() end,
             case when $6 = 'lapsed' then now() - interval '1 hour' else now() + interval '48 hours' end,
             $5,
             case when $6 = 'released' then now() end)`,
    [invitationId, s.studioId, entryId, hash64(), s.practitionerId, lifecycle],
  );
  return { invitationId, entryId };
}

const setWaitlistSms = (s: SeededStudio, on: boolean) =>
  q(`update public.studios set send_waitlist_invitation_sms = $2 where id = $1`, [s.studioId, on]);

const begin = (s: SeededStudio, apptId: string, purpose: string) =>
  q<{ id: string | null }>(`select public.begin_appointment_sms_message($1,$2,$3) as id`, [
    s.studioId,
    apptId,
    purpose,
  ]).then((r) => r[0]!.id);

type ClaimRow = {
  result: string;
  message_id: string | null;
  phone: string | null;
  sms_consent_at: string | null;
  sms_opted_out_at: string | null;
  mobile_verified_at: string | null;
  expires_at: string | null;
};
const claim = (studioId: string, invitationId: string) =>
  q<ClaimRow>(`select * from public.claim_waitlist_invitation_sms($1,$2)`, [
    studioId,
    invitationId,
  ]).then((r) => r[0]!);

const settle = (
  id: string,
  outcome: string,
  messageSid: string | null = null,
  errorCode: number | null = null,
  skipReason: string | null = null,
) =>
  q<{ r: string }>(`select public.settle_sms_message($1,$2,$3,$4,$5) as r`, [
    id,
    outcome,
    messageSid,
    errorCode,
    skipReason,
  ]).then((r) => r[0]!.r);

type StatusRow = {
  result: string;
  studio_id: string | null;
  purpose: string | null;
  status: string | null;
  appointment_id: string | null;
};
const report = (id: string, messageSid: string, status: string, errorCode: number | null = null) =>
  q<StatusRow>(`select * from public.record_sms_delivery_status($1,$2,$3,$4)`, [
    id,
    messageSid,
    status,
    errorCode,
  ]).then((r) => r[0]!);

const row = (id: string) =>
  q<{
    status: string;
    provider_message_sid: string | null;
    provider_error_code: number | null;
    skip_reason: string | null;
    settled_at: string | null;
    provider_status_at: string | null;
  }>(
    `select status, provider_message_sid, provider_error_code, skip_reason,
            settled_at::text, provider_status_at::text
       from public.sms_outbound_messages where id = $1`,
    [id],
  ).then((r) => r[0]);

const COMMANDS = [
  "public.begin_appointment_sms_message(uuid,uuid,text)",
  "public.claim_waitlist_invitation_sms(uuid,uuid)",
  "public.settle_sms_message(uuid,text,text,integer,text)",
  "public.record_sms_delivery_status(uuid,text,text,integer)",
  "public.claim_reminder_sms_send(uuid,text,timestamptz,timestamptz)",
] as const;

// ---------------------------------------------------------------------------

describe("privilege closure", () => {
  it("no role holds any table privilege on the ledger", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const [r] = await q<{ p: boolean }>(
          `select has_table_privilege($1, 'public.sms_outbound_messages', $2) as p`,
          [role, priv],
        );
        expect(r!.p, `${role} holds ${priv}`).toBe(false);
      }
    }
  });

  it("RLS is on and no policy exists, so no browser session can ever read a row", async () => {
    const [rls] = await q<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = 'public.sms_outbound_messages'::regclass`,
    );
    expect(rls!.on).toBe(true);
    const [p] = await q<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'sms_outbound_messages'`,
    );
    expect(p!.n).toBe(0);
  });

  it("only service_role may execute the five commands", async () => {
    for (const fn of COMMANDS) {
      for (const [role, expected] of [
        ["service_role", true],
        ["authenticated", false],
        ["anon", false],
      ] as const) {
        const [r] = await q<{ p: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as p`,
          [role, fn],
        );
        expect(r!.p, `${role} EXECUTE ${fn}`).toBe(expected);
      }
    }
  });

  it("an authenticated session calling a command is refused by the privilege layer", async () => {
    // Anti-vacuity: the same statement succeeds for service_role, so the
    // refusal below is the grant, not a malformed call.
    await expect(
      asRole("service_role", (query) =>
        query(`select public.settle_sms_message($1,'unknown',null,null,null)`, [randomUUID()]),
      ),
    ).resolves.toBeDefined();
    const code = await asRole("authenticated", (query) =>
      query(`select public.settle_sms_message($1,'unknown',null,null,null)`, [randomUUID()]),
    ).then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );
    expect(code).toBe("42501");
  });

  it("the switch defaults OFF for a new studio", async () => {
    const [r] = await q<{ on: boolean }>(
      `select send_waitlist_invitation_sms as on from public.studios where id = $1`,
      [A.studioId],
    );
    expect(r!.on).toBe(false);
  });
});

describe("begin_appointment_sms_message", () => {
  it("creates one claimed attempt for the studio's own appointment", async () => {
    const appt = await seedAppointment(A);
    const id = await begin(A, appt, "appointment_reminder_24h");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await row(id!))!.status).toBe("claimed");
  });

  it("refuses another studio's appointment with null and writes nothing", async () => {
    const appt = await seedAppointment(A);
    expect(await begin(B, appt, "appointment_reminder_24h")).toBeNull();
    const [n] = await q<{ n: number }>(
      `select count(*)::int as n from public.sms_outbound_messages where appointment_id = $1`,
      [appt],
    );
    expect(n!.n).toBe(0);
  });

  it("refuses a waitlist purpose and an unknown purpose", async () => {
    const appt = await seedAppointment(A);
    expect(await begin(A, appt, "waitlist_invitation")).toBeNull();
    expect(await begin(A, appt, "marketing")).toBeNull();
  });
});

describe("claim_waitlist_invitation_sms: at most one text per live invitation", () => {
  afterEach(async () => {
    await setWaitlistSms(A, false);
  });

  it("is refused while the studio switch is off, and writes no row", async () => {
    const { invitationId } = await seedInvitation(A);
    expect((await claim(A.studioId, invitationId)).result).toBe("studio_disabled");
    const [n] = await q<{ n: number }>(
      `select count(*)::int as n from public.sms_outbound_messages where waitlist_invitation_id = $1`,
      [invitationId],
    );
    expect(n!.n).toBe(0);
  });

  it("claims once and returns the prospect's SMS facts; the second claim is refused", async () => {
    await setWaitlistSms(A, true);
    const { invitationId } = await seedInvitation(A);
    const first = await claim(A.studioId, invitationId);
    expect(first.result).toBe("claimed");
    expect(first.message_id).not.toBeNull();
    expect(first.phone).toBe("+16475550123");
    expect(first.sms_consent_at).not.toBeNull();
    expect(first.mobile_verified_at).not.toBeNull();
    expect(first.sms_opted_out_at).toBeNull();
    expect(first.expires_at).not.toBeNull();

    const second = await claim(A.studioId, invitationId);
    expect(second.result).toBe("already_claimed");
    expect(second.message_id).toBeNull();
    const [n] = await q<{ n: number }>(
      `select count(*)::int as n from public.sms_outbound_messages where waitlist_invitation_id = $1`,
      [invitationId],
    );
    expect(n!.n).toBe(1);
  });

  it("returns consent facts without deciding them: an opted-out prospect is still claimed", async () => {
    // The application's prospectMayReceiveSms is the one authority on
    // consent; the claim reports, and the settle records the decision.
    await setWaitlistSms(A, true);
    const { invitationId } = await seedInvitation(A, { optedOut: true, verified: false });
    const r = await claim(A.studioId, invitationId);
    expect(r.result).toBe("claimed");
    expect(r.sms_opted_out_at).not.toBeNull();
    expect(r.mobile_verified_at).toBeNull();
  });

  it("another studio cannot claim the invitation", async () => {
    await setWaitlistSms(A, true);
    await setWaitlistSms(B, true);
    const { invitationId } = await seedInvitation(A);
    expect((await claim(B.studioId, invitationId)).result).toBe("not_found");
    await setWaitlistSms(B, false);
  });

  it("a lapsed or released invitation is not live and is not claimed", async () => {
    await setWaitlistSms(A, true);
    const lapsed = await seedInvitation(A, { lifecycle: "lapsed" });
    const released = await seedInvitation(A, { lifecycle: "released" });
    expect((await claim(A.studioId, lapsed.invitationId)).result).toBe("not_live");
    expect((await claim(A.studioId, released.invitationId)).result).toBe("not_live");
  });

  it("refuses null input without a row", async () => {
    const r = await q<ClaimRow>(`select * from public.claim_waitlist_invitation_sms(null, null)`);
    expect(r[0]!.result).toBe("invalid_input");
  });
});

describe("settle_sms_message", () => {
  it("accepted records the SID; nothing settles twice", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_reminder_2h"))!;
    const s = sid();
    expect(await settle(id, "accepted", s)).toBe("settled");
    const r = (await row(id))!;
    expect(r.status).toBe("accepted");
    expect(r.provider_message_sid).toBe(s);
    expect(r.settled_at).not.toBeNull();

    expect(await settle(id, "accepted", s)).toBe("already_settled");
    expect(await settle(id, "refused")).toBe("not_claimed");
    expect((await row(id))!.status).toBe("accepted");
  });

  it("refused and unknown carry a numeric provider code; skipped carries a reason", async () => {
    const refused = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect(await settle(refused, "refused", null, 21211)).toBe("settled");
    expect((await row(refused))!.provider_error_code).toBe(21211);

    const unknown = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect(await settle(unknown, "unknown")).toBe("settled");
    expect((await row(unknown))!.status).toBe("unknown");

    const skipped = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect(await settle(skipped, "skipped", null, null, "non_production_deployment")).toBe("settled");
    expect((await row(skipped))!.skip_reason).toBe("non_production_deployment");
  });

  it("refuses incoherent input and leaves the row claimed", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect(await settle(id, "accepted", null)).toBe("invalid_input"); // no SID
    expect(await settle(id, "accepted", "not-a-sid")).toBe("invalid_input");
    expect(await settle(id, "refused", sid())).toBe("invalid_input"); // SID on a refusal
    expect(await settle(id, "skipped")).toBe("invalid_input"); // no reason
    expect(await settle(id, "skipped", null, null, "+16475550123")).toBe("invalid_input"); // a phone is not a slug
    expect(await settle(id, "accepted", sid(), 30003)).toBe("invalid_input"); // code on success
    expect(await settle(id, "delivered", sid())).toBe("invalid_input"); // callbacks own that word
    expect((await row(id))!.status).toBe("claimed");
    expect(await settle(randomUUID(), "unknown")).toBe("not_found");
  });
});

describe("record_sms_delivery_status", () => {
  it("moves forward only; the three end states are terminal", async () => {
    const appt = await seedAppointment(A);
    const id = (await begin(A, appt, "appointment_reminder_24h"))!;
    const s = sid();
    await settle(id, "accepted", s);

    const sent = await report(id, s, "sent");
    expect(sent).toMatchObject({
      result: "updated",
      studio_id: A.studioId,
      purpose: "appointment_reminder_24h",
      status: "sent",
      appointment_id: appt,
    });
    expect((await report(id, s, "queued")).result).toBe("stale"); // late and out of order
    expect((await report(id, s, "delivered")).result).toBe("updated");
    expect((await report(id, s, "failed")).result).toBe("stale"); // terminal
    expect((await row(id))!.status).toBe("delivered");
  });

  it("records a failure's numeric error code", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_reminder_24h"))!;
    const s = sid();
    await settle(id, "accepted", s);
    expect((await report(id, s, "undelivered", 30003)).result).toBe("updated");
    const r = (await row(id))!;
    expect(r.status).toBe("undelivered");
    expect(r.provider_error_code).toBe(30003);
    expect(r.provider_status_at).not.toBeNull();
  });

  it("a callback that beats the settle lands on the claimed row, and the settle then agrees", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    const s = sid();
    expect((await report(id, s, "queued")).result).toBe("updated");
    expect((await row(id))!.provider_message_sid).toBe(s);
    expect(await settle(id, "accepted", s)).toBe("already_settled");
    // An ambiguous settle that arrives after the provider's own report cannot
    // overwrite it.
    expect(await settle(id, "unknown")).toBe("already_settled");
    expect((await row(id))!.status).toBe("queued");
  });

  it("resolves an ambiguous settle into the provider's answer", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect(await settle(id, "unknown")).toBe("settled");
    const s = sid();
    expect((await report(id, s, "delivered")).result).toBe("updated");
    const r = (await row(id))!;
    expect(r.status).toBe("delivered");
    expect(r.provider_message_sid).toBe(s);
  });

  it("never crosses attempts: a different SID is refused", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    const s = sid();
    await settle(id, "accepted", s);
    expect((await report(id, sid(), "delivered")).result).toBe("sid_mismatch");
    expect((await row(id))!.status).toBe("accepted");
  });

  it("a skipped or refused attempt cannot receive a delivery report", async () => {
    const skipped = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    await settle(skipped, "skipped", null, null, "provider_not_configured");
    expect((await report(skipped, sid(), "delivered")).result).toBe("not_sent");
    const refused = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    await settle(refused, "refused", null, 21610);
    expect((await report(refused, sid(), "delivered")).result).toBe("not_sent");
  });

  it("an unknown row id or a malformed SID changes nothing", async () => {
    expect((await report(randomUUID(), sid(), "delivered")).result).toBe("unknown_message");
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    expect((await report(id, "SMnope", "delivered")).result).toBe("invalid_input");
    expect((await report(id, sid(), "received")).result).toBe("invalid_input");
    expect((await row(id))!.status).toBe("claimed");
  });
});

describe("identity is write-once even for the table owner", () => {
  it("purpose, subject and a written SID cannot be rewritten", async () => {
    const id = (await begin(A, await seedAppointment(A), "appointment_confirmation"))!;
    const s = sid();
    await settle(id, "accepted", s);
    const attempt = (sql: string, params: unknown[]) =>
      adminQuery(sql, params).then(
        () => null,
        (e: { code?: string }) => e.code ?? "unknown",
      );
    expect(
      await attempt(
        `update public.sms_outbound_messages set purpose = 'appointment_reminder_2h' where id = $1`,
        [id],
      ),
    ).toBe("42501");
    expect(
      await attempt(`update public.sms_outbound_messages set provider_message_sid = $2 where id = $1`, [
        id,
        sid(),
      ]),
    ).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// The claim cannot race a lifecycle command (Codex P2 4211982451).
// ---------------------------------------------------------------------------

describe("claim_waitlist_invitation_sms waits for, then sees, a racing lifecycle command", () => {
  afterEach(async () => {
    await setWaitlistSms(A, false);
  });

  async function connect(): Promise<Client> {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    return c;
  }

  /** Hold the invitation row the way a lifecycle command does: an uncommitted
   *  write to it. Then claim from a second session. */
  async function raceClaimAgainst(outcome: "commit" | "rollback") {
    await setWaitlistSms(A, true);
    const { invitationId } = await seedInvitation(A);
    const lifecycle = await connect();
    const claimer = await connect();
    try {
      await lifecycle.query("begin");
      await lifecycle.query(
        `update public.new_client_waitlist_invitations set released_at = now() where id = $1`,
        [invitationId],
      );
      const pid = (await claimer.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
      const pending = claimer.query(`select * from public.claim_waitlist_invitation_sms($1,$2)`, [
        A.studioId,
        invitationId,
      ]);
      // The claim must PARK on the lifecycle write rather than read past it.
      expect(await waitUntilBlocked(pid), "the claim did not wait for the lifecycle write").not.toBeNull();
      await lifecycle.query(outcome);
      const r = (await pending).rows[0] as ClaimRow;
      const [n] = await q<{ n: number }>(
        `select count(*)::int as n from public.sms_outbound_messages where waitlist_invitation_id = $1`,
        [invitationId],
      );
      return { result: r.result, rows: n!.n };
    } finally {
      await lifecycle.end().catch(() => undefined);
      await claimer.end().catch(() => undefined);
    }
  }

  it("a release that commits first is SEEN: not_live, and no row", async () => {
    expect(await raceClaimAgainst("commit")).toEqual({ result: "not_live", rows: 0 });
  });

  it("a lifecycle write that rolls back leaves the invitation live: claimed (the control)", async () => {
    expect(await raceClaimAgainst("rollback")).toEqual({ result: "claimed", rows: 1 });
  });
});

// ---------------------------------------------------------------------------
// claim_reminder_sms_send: validate and claim in one transaction (Codex P2
// 4212576115 on #813 -- a failed post-claim read used to spend an attempt).
// ---------------------------------------------------------------------------

describe("claim_reminder_sms_send", () => {
  type Rc = { result: string; starts_at: string | null };
  const window = async (apptId: string, beforeH: number, afterH: number) => {
    const [r] = await q<{ ws: string; we: string }>(
      `select (starts_at - make_interval(hours => $2))::text ws,
              (starts_at + make_interval(hours => $3))::text we
         from public.appointments where id = $1`,
      [apptId, beforeH, afterH],
    );
    return [r!.ws, r!.we] as const;
  };
  const rclaim = (apptId: string, type: string, ws: string, we: string) =>
    q<Rc>(`select * from public.claim_reminder_sms_send($1,$2,$3::timestamptz,$4::timestamptz)`, [
      apptId,
      type,
      ws,
      we,
    ]).then((r) => r[0]!);
  const slot = (apptId: string) =>
    q<{ attempts: number; claimed: boolean; sent: boolean }>(
      `select sms_reminder_24h_send_attempts as attempts,
              sms_reminder_24h_claimed_at is not null as claimed,
              sms_reminder_24h_sent_at is not null as sent
         from public.appointments where id = $1`,
      [apptId],
    ).then((r) => r[0]!);

  it("claims a confirmed appointment inside the window and returns its start", async () => {
    const appt = await seedAppointment(A);
    const [ws, we] = await window(appt, 1, 1);
    const r = await rclaim(appt, "reminder_24h", ws, we);
    expect(r.result).toBe("claimed");
    expect(r.starts_at).not.toBeNull();
    expect(await slot(appt)).toEqual({ attempts: 1, claimed: true, sent: false });
    // A second claim while the first is fresh is refused and spends nothing.
    expect((await rclaim(appt, "reminder_24h", ws, we)).result).toBe("not_claimed");
    expect((await slot(appt)).attempts).toBe(1);
  });

  it("a cancelled appointment is refused and spends NO attempt", async () => {
    const appt = await seedAppointment(A);
    const [ws, we] = await window(appt, 1, 1);
    await adminQuery(
      `update public.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
      [appt],
    );
    expect((await rclaim(appt, "reminder_24h", ws, we)).result).toBe("not_confirmed");
    expect(await slot(appt)).toEqual({ attempts: 0, claimed: false, sent: false });
  });

  it("a start outside the window is refused, spends NO attempt, and reports the start", async () => {
    const appt = await seedAppointment(A);
    const [ws, we] = await window(appt, -2, 4); // the window begins after the start
    const r = await rclaim(appt, "reminder_24h", ws, we);
    expect(r.result).toBe("outside_window");
    expect(r.starts_at).not.toBeNull();
    expect((await slot(appt)).attempts).toBe(0);
  });

  it("refuses a confirmation type, a missing window and an unknown appointment", async () => {
    const appt = await seedAppointment(A);
    const [ws, we] = await window(appt, 1, 1);
    expect((await rclaim(appt, "confirmation", ws, we)).result).toBe("invalid_input");
    expect(
      (await q<Rc>(`select * from public.claim_reminder_sms_send($1,'reminder_2h',null,null)`, [appt]))[0]!
        .result,
    ).toBe("invalid_input");
    expect((await rclaim(randomUUID(), "reminder_24h", ws, we)).result).toBe("not_found");
    expect((await slot(appt)).attempts).toBe(0);
  });

  describe("a cancel or move racing the claim is waited for, then seen", () => {
    async function connect(): Promise<Client> {
      const c = new Client({ connectionString: resolveLocalDbUrl() });
      await c.connect();
      return c;
    }

    async function raceAgainst(change: string, outcome: "commit" | "rollback") {
      const appt = await seedAppointment(A);
      const [ws, we] = await window(appt, 1, 1);
      const writer = await connect();
      const claimer = await connect();
      try {
        await writer.query("begin");
        await writer.query(change, [appt]);
        const pid = (await claimer.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
        const pending = claimer.query(
          `select * from public.claim_reminder_sms_send($1,'reminder_24h',$2::timestamptz,$3::timestamptz)`,
          [appt, ws, we],
        );
        expect(await waitUntilBlocked(pid), "the claim did not wait for the racing write").not.toBeNull();
        await writer.query(outcome);
        const r = (await pending).rows[0] as Rc;
        return { result: r.result, attempts: (await slot(appt)).attempts };
      } finally {
        await writer.end().catch(() => undefined);
        await claimer.end().catch(() => undefined);
      }
    }

    it("a cancellation that commits first is SEEN: not_confirmed, no attempt", async () => {
      expect(
        await raceAgainst(
          `update public.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
          "commit",
        ),
      ).toEqual({ result: "not_confirmed", attempts: 0 });
    });

    it("a move out of the window that commits first is SEEN: outside_window, no attempt", async () => {
      expect(
        await raceAgainst(
          `update public.appointments
              set starts_at = starts_at + interval '5 hours', ends_at = ends_at + interval '5 hours'
            where id = $1`,
          "commit",
        ),
      ).toEqual({ result: "outside_window", attempts: 0 });
    });

    it("a racing write that rolls back leaves the claim to proceed (the control)", async () => {
      expect(
        await raceAgainst(
          `update public.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
          "rollback",
        ),
      ).toEqual({ result: "claimed", attempts: 1 });
    });
  });
});
