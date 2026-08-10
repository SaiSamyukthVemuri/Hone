import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool } from "./helpers/harness";
import { createHash, randomUUID } from "node:crypto";
import { buildPolicySnapshot } from "@/lib/booking/policy-acknowledgement";

// ===========================================================================
// 0171 — public.reschedule_appointment_v2, proven on the real migrated DB.
// ===========================================================================
//
// The legacy reschedule_appointment accepted a caller-supplied end time AND
// duration, validated only broad time ordering, never checked the horizon,
// availability window, blockouts or slot membership, never wrote lineage or
// cancellation_kind, and left the policy acknowledgement to a detached
// post-commit statement in the route. This command owns all of it in one
// transaction.
//
// GOTCHA that shaped this file, inherited from 0170: the command enforces the
// public booking horizon (public_booking_horizon_months * 31 days), so the
// repository's usual fixed far-future instant (2031-09-15) is REFUSED with
// 'outside_horizon'. Every instant below is computed relative to now().
//
// SECOND GOTCHA: the studio is seeded open 00:00-23:59 every weekday, so the
// hourly fallback family (FALLBACK_GRANULARITY_MINUTES = 60) makes every whole
// UTC hour a candidate. Any test that wants a NON-candidate must pick an
// off-hour minute (e.g. :17), not merely a different hour.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Fixture = {
  studioId: string;
  ownerId: string;
  clientId: string;
  serviceId: string;
  originalId: string;
  originalHash: string;
  originalStart: string;
};

/** An instant `days` from now at `hh:mm` UTC, millisecond-clean. */
function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

async function seed(
  label: string,
  opts: {
    buffer?: number;
    tz?: string;
    durationMinutes?: number;
    serviceDefaultMinutes?: number;
    capacity?: boolean;
    cancellationPolicy?: string | null;
    noShowPolicy?: string | null;
  } = {},
): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const originalId = randomUUID();
  const originalHash = hash64();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;
  const duration = opts.durationMinutes ?? 45;

  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug,
        public_booking_horizon_months, practitioner_capacity_enabled,
        cancellation_policy_text, no_show_policy_text)
     values ($1, $2, $3, $4, $5, $6, 3, $7, $8, $9)`,
    [
      studioId,
      `Harness ${label}`,
      email,
      opts.tz ?? "UTC",
      opts.buffer ?? 15,
      `${label}-${studioId.slice(0, 8)}`,
      opts.capacity ?? false,
      opts.cancellationPolicy ?? null,
      opts.noShowPolicy ?? null,
    ],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [ownerId, studioId, userId, `Owner ${label}`, email],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [
    clientId,
    studioId,
    `Client ${label}`,
    `client-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Consultation', $3, true)`,
    [serviceId, studioId, opts.serviceDefaultMinutes ?? duration],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );

  const originalStart = at(10, 14, 0);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, notes, referral_source, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => $7), $7,
             'confirmed', 'original notes', 'instagram', $8)`,
    [originalId, studioId, ownerId, clientId, serviceId, originalStart, duration, originalHash],
  );

  return { studioId, ownerId, clientId, serviceId, originalId, originalHash, originalStart };
}

type CommandRow = {
  result: string;
  original_appointment_id: string | null;
  new_appointment_id: string | null;
  studio_id: string | null;
  client_id: string | null;
  service_id: string | null;
  practitioner_id: string | null;
  original_starts_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  duration_minutes: number | null;
  created_at: string | null;
  policy_acknowledgement_id: string | null;
};

async function reschedule(
  f: Fixture,
  newStart: string,
  opts: {
    tokenHash?: string;
    newHash?: string;
    ack?: boolean;
    presentedHash?: string | null;
    appointmentId?: string;
  } = {},
): Promise<CommandRow> {
  const r = await adminQuery(
    `select * from public.reschedule_appointment_v2($1,$2,$3,$4,$5,$6)`,
    [
      opts.appointmentId ?? f.originalId,
      opts.tokenHash ?? f.originalHash,
      newStart,
      opts.newHash ?? hash64(),
      opts.ack ?? true,
      opts.presentedHash === undefined ? null : opts.presentedHash,
    ],
  );
  return r.rows[0] as CommandRow;
}

/** The canonical hash of a studio's CURRENT policy text, via the TS helper. */
async function currentPolicyHash(studioId: string): Promise<string> {
  const r = await adminQuery(
    `select cancellation_policy_text, no_show_policy_text from public.studios where id = $1`,
    [studioId],
  );
  return buildPolicySnapshot({
    cancellationPolicyText: r.rows[0].cancellation_policy_text,
    noShowPolicyText: r.rows[0].no_show_policy_text,
  }).policySnapshotHash;
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------

describe("0171 reschedule_appointment_v2 — the successful reschedule", () => {
  it("cancels the original, creates exactly one successor, and writes complete lineage", async () => {
    const f = await seed("happy");
    const target = at(11, 10, 0);
    const newHash = hash64();

    const out = await reschedule(f, target, { newHash });
    expect(out.result).toBe("success");
    expect(out.new_appointment_id).toBeTruthy();
    expect(out.original_appointment_id).toBe(f.originalId);

    // --- the ORIGINAL ---
    const orig = (
      await adminQuery(`select * from public.appointments where id = $1`, [f.originalId])
    ).rows[0];
    expect(orig.status).toBe("cancelled");
    expect(orig.cancelled_by).toBe("client");
    expect(orig.cancellation_kind).toBe("rescheduled");
    expect(orig.cancelled_at).not.toBeNull();
    expect(orig.rescheduled_to_appointment_id).toBe(out.new_appointment_id);
    // The original keeps its own token; only the successor gets the new one.
    expect(orig.cancellation_token_hash).toBe(f.originalHash);

    // --- the SUCCESSOR ---
    const succ = (
      await adminQuery(`select * from public.appointments where id = $1`, [out.new_appointment_id])
    ).rows[0];
    expect(succ.status).toBe("confirmed");
    expect(succ.studio_id).toBe(f.studioId);
    expect(succ.client_id).toBe(f.clientId);
    expect(succ.service_id).toBe(f.serviceId);
    expect(succ.practitioner_id).toBe(f.ownerId);
    expect(succ.rescheduled_from_appointment_id).toBe(f.originalId);
    expect(succ.rescheduled_to_appointment_id).toBeNull();
    expect(succ.cancellation_token_hash).toBe(newHash);
    expect(succ.cancellation_kind).toBeNull();
    expect(succ.cancelled_at).toBeNull();
    expect(succ.cancelled_by).toBeNull();
    expect(succ.cancellation_reason).toBeNull();
    expect(succ.booked_outside_availability).toBe(false);

    // Preserved booking context the LEGACY RPC silently dropped.
    expect(succ.notes).toBe("original notes");
    expect(succ.referral_source).toBe("instagram");

    // Authoritative times: end is derived from the ORIGINAL duration.
    expect(new Date(succ.starts_at).toISOString()).toBe(target);
    expect(succ.duration_minutes).toBe(45);
    expect(
      new Date(succ.ends_at).getTime() - new Date(succ.starts_at).getTime(),
    ).toBe(45 * 60_000);

    // Trigger-derived fields are present and correct.
    expect(succ.sync_version).toBe(1);
    expect(succ.buffer_minutes_snapshot).toBe(15);
    expect(new Date(succ.blocked_ends_at).getTime()).toBe(
      new Date(succ.ends_at).getTime() + 15 * 60_000,
    );

    // Send state is FRESH — nothing inherited, so the successor can send its
    // own confirmation.
    expect(succ.confirmation_sent_at).toBeNull();
    expect(succ.confirmation_send_attempts).toBe(0);
    expect(succ.confirmation_claimed_at).toBeNull();
    expect(succ.sms_confirmation_sent_at).toBeNull();
    expect(succ.sms_confirmation_claimed_at).toBeNull();
    expect(succ.reminder_24h_sent_at).toBeNull();
    expect(succ.postcare_email_sent_at).toBeNull();

    // Exactly ONE successor.
    const successors = await adminQuery(
      `select count(*)::int n from public.appointments
        where rescheduled_from_appointment_id = $1`,
      [f.originalId],
    );
    expect(successors.rows[0].n).toBe(1);
  });

  it("returns authoritative state matching the persisted row, so no re-read is needed", async () => {
    const f = await seed("authoritative");
    const target = at(12, 9, 0);
    const out = await reschedule(f, target);
    expect(out.result).toBe("success");

    const succ = (
      await adminQuery(`select * from public.appointments where id = $1`, [out.new_appointment_id])
    ).rows[0];
    expect(new Date(out.starts_at!).toISOString()).toBe(new Date(succ.starts_at).toISOString());
    expect(new Date(out.ends_at!).toISOString()).toBe(new Date(succ.ends_at).toISOString());
    expect(out.duration_minutes).toBe(succ.duration_minutes);
    expect(out.practitioner_id).toBe(succ.practitioner_id);
    expect(out.studio_id).toBe(succ.studio_id);
    expect(out.client_id).toBe(succ.client_id);
    expect(out.service_id).toBe(succ.service_id);
    expect(new Date(out.created_at!).toISOString()).toBe(
      new Date(succ.created_at).toISOString(),
    );
    expect(new Date(out.original_starts_at!).toISOString()).toBe(
      new Date(f.originalStart).toISOString(),
    );
  });

  it("writes exactly two audit rows with the canonical shapes", async () => {
    const f = await seed("audits");
    const out = await reschedule(f, at(11, 11, 0));
    expect(out.result).toBe("success");

    const cancelAudit = (
      await adminQuery(
        `select * from public.appointment_audit where appointment_id = $1`,
        [f.originalId],
      )
    ).rows;
    expect(cancelAudit).toHaveLength(1);
    expect(cancelAudit[0].action).toBe("cancelled");
    expect(cancelAudit[0].actor_type).toBe("client");
    expect(cancelAudit[0].actor_id).toBeNull();
    expect(cancelAudit[0].details.reason).toBe("rescheduled");
    expect(cancelAudit[0].details.source).toBe("reschedule_link");
    expect(cancelAudit[0].details.new_appointment_id).toBe(out.new_appointment_id);

    const createAudit = (
      await adminQuery(
        `select * from public.appointment_audit where appointment_id = $1`,
        [out.new_appointment_id],
      )
    ).rows;
    expect(createAudit).toHaveLength(1);
    expect(createAudit[0].action).toBe("created");
    expect(createAudit[0].actor_type).toBe("client");
    expect(createAudit[0].actor_id).toBeNull();
    expect(createAudit[0].details.source).toBe("reschedule_link");
    expect(createAudit[0].details.original_appointment_id).toBe(f.originalId);
  });

  it("moves the shadow reservation from the original to the successor", async () => {
    const f = await seed("reservations");
    const before = await adminQuery(
      `select count(*)::int n from public.studio_calendar_reservations
        where source_kind = 'appointment' and source_id = $1`,
      [f.originalId],
    );
    expect(before.rows[0].n).toBe(1);

    const out = await reschedule(f, at(11, 12, 0));
    expect(out.result).toBe("success");

    const origRes = await adminQuery(
      `select count(*)::int n from public.studio_calendar_reservations
        where source_kind = 'appointment' and source_id = $1`,
      [f.originalId],
    );
    expect(origRes.rows[0].n).toBe(0);

    const succRes = await adminQuery(
      `select * from public.studio_calendar_reservations
        where source_kind = 'appointment' and source_id = $1`,
      [out.new_appointment_id],
    );
    expect(succRes.rows).toHaveLength(1);
    // Capacity OFF -> resource_key is the studio. Actual interval, no buffer.
    expect(succRes.rows[0].resource_key).toBe(f.studioId);
    expect(succRes.rows[0].studio_id).toBe(f.studioId);
    expect(new Date(succRes.rows[0].starts_at).toISOString()).toBe(
      new Date(out.starts_at!).toISOString(),
    );
    expect(new Date(succRes.rows[0].ends_at).toISOString()).toBe(
      new Date(out.ends_at!).toISOString(),
    );
  });
});

// ---------------------------------------------------------------------------

describe("0171 — duration authority (the drift defect)", () => {
  it("preserves the ORIGINAL 45-minute duration after the service default changes to 60", async () => {
    const f = await seed("drift", { durationMinutes: 45, serviceDefaultMinutes: 45 });
    // The studio lengthens the service AFTER the client booked.
    await adminQuery(
      `update public.services set default_duration_minutes = 60 where id = $1`,
      [f.serviceId],
    );

    const target = at(11, 13, 0);

    // The SQL candidate generator offers the slot at the ORIGINAL duration.
    // Queried BEFORE the mutation: afterwards the successor owns that interval
    // and correctly blocks it.
    const cands = await adminQuery(
      `select count(*)::int n from public.public_reschedule_slot_candidates($1, $2::date, 45, $3, $4) c
        where c = $5::timestamptz`,
      [f.studioId, target.slice(0, 10), f.originalId, f.ownerId, target],
    );
    expect(cands.rows[0].n).toBe(1);

    const out = await reschedule(f, target);
    expect(out.result).toBe("success");

    // The command's own return, and the persisted row, both say 45.
    expect(out.duration_minutes).toBe(45);
    const succ = (
      await adminQuery(`select duration_minutes, starts_at, ends_at from public.appointments where id = $1`, [
        out.new_appointment_id,
      ])
    ).rows[0];
    expect(succ.duration_minutes).toBe(45);
    expect(
      new Date(succ.ends_at).getTime() - new Date(succ.starts_at).getTime(),
    ).toBe(45 * 60_000);
  });
});

// ---------------------------------------------------------------------------

describe("0171 — exact replacement-slot membership", () => {
  it("rejects an off-grid start the page would never offer", async () => {
    const f = await seed("offgrid");
    const out = await reschedule(f, at(11, 10, 17));
    expect(out.result).toBe("not_a_public_slot");
    await expectUnchanged(f);
  });

  it("rejects a start one millisecond off a legitimate candidate", async () => {
    const f = await seed("msdrift");
    const legit = at(11, 10, 0);
    const offByOne = new Date(new Date(legit).getTime() + 1).toISOString();
    const out = await reschedule(f, offByOne);
    expect(out.result).toBe("not_a_public_slot");
    await expectUnchanged(f);
  });

  it("REJECTS sub-millisecond input rather than truncating it", async () => {
    const f = await seed("submilli");
    const r = await adminQuery(
      `select result from public.reschedule_appointment_v2(
         $1, $2,
         ($3::timestamptz + interval '123456 microseconds'),
         $4, true, null)`,
      [f.originalId, f.originalHash, at(11, 10, 0), hash64()],
    );
    expect(r.rows[0].result).toBe("invalid_time");
    await expectUnchanged(f);
  });

  it("refuses the SAME time as a no-op even though the exclusion makes it free", async () => {
    const f = await seed("sametime");
    // Proof the exclusion really does re-offer the original's own start.
    const isCandidate = await adminQuery(
      `select count(*)::int n from public.public_reschedule_slot_candidates($1, $2::date, 45, $3, $4) c
        where c = $5::timestamptz`,
      [f.studioId, f.originalStart.slice(0, 10), f.originalId, f.ownerId, f.originalStart],
    );
    expect(isCandidate.rows[0].n).toBe(1);

    const out = await reschedule(f, f.originalStart);
    expect(out.result).toBe("same_time");
    await expectUnchanged(f);
  });

  it("EXCLUDES the original's own reservation — and the negative control proves it matters", async () => {
    const f = await seed("exclusion");
    const day = f.originalStart.slice(0, 10);

    const withExclusion = await adminQuery(
      `select count(*)::int n from public.public_reschedule_slot_candidates($1, $2::date, 45, $3, $4) c
        where c = $5::timestamptz`,
      [f.studioId, day, f.originalId, f.ownerId, f.originalStart],
    );
    expect(withExclusion.rows[0].n).toBe(1);

    // NEGATIVE CONTROL: without the exclusion the original's own start is
    // blocked by its own reservation, which is exactly the bug this closes.
    const withoutExclusion = await adminQuery(
      `select count(*)::int n from public.public_reschedule_slot_candidates($1, $2::date, 45, null, $3) c
        where c = $4::timestamptz`,
      [f.studioId, day, f.ownerId, f.originalStart],
    );
    expect(withoutExclusion.rows[0].n).toBe(0);
  });

  it("still treats OTHER appointments' reservations as conflicts", async () => {
    const f = await seed("otherconflict", { buffer: 0 });
    const blockerStart = at(11, 10, 0);
    await adminQuery(
      `insert into public.appointments
         (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
          duration_minutes, status, cancellation_token_hash)
       values ($1,$2,$3,$4,$5, $5::timestamptz + make_interval(mins => 45), 45,
               'confirmed', $6)`,
      [f.studioId, f.ownerId, f.clientId, f.serviceId, blockerStart, hash64()],
    );

    const out = await reschedule(f, blockerStart);
    // Another appointment already owns that exact interval.
    expect(["time_unavailable", "not_a_public_slot"]).toContain(out.result);
    await expectUnchanged(f);
  });
});

// ---------------------------------------------------------------------------

describe("0171 — policy freshness", () => {
  it("requires no acknowledgement and writes no row when the studio has no policy", async () => {
    const f = await seed("nopolicy");
    const out = await reschedule(f, at(11, 10, 0), { ack: false, presentedHash: null });
    expect(out.result).toBe("success");
    expect(out.policy_acknowledgement_id).toBeNull();

    const acks = await adminQuery(
      `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
      [f.studioId],
    );
    expect(acks.rows[0].n).toBe(0);
  });

  // REGRESSION: the SQL requirement predicate must match JavaScript
  // String.prototype.trim(), not Postgres btrim(). btrim() with no second
  // argument strips ONLY spaces, so a policy of "   \n\t  " survived it
  // non-empty while hasAnyPolicy() trimmed it to "". The page would then render
  // NO checkbox while the command demanded one — public rescheduling
  // permanently broken for that studio, unsatisfiable by the visitor.
  it.each([
    ["spaces only", "     "],
    ["space + LF + tab", "   \n\t  "],
    ["CRLF only", "\r\n\r\n"],
    ["vertical tab + form feed", "\v\f"],
    ["non-breaking space", "  "],
    ["zero-width no-break space (BOM)", "﻿"],
    ["BOM + ordinary whitespace", "﻿  \n "],
  ])("treats a whitespace-only policy (%s) as NO policy, exactly as hasAnyPolicy does", async (_label, ws) => {
    const f = await seed(`wspolicy-${randomUUID().slice(0, 8)}`, {
      cancellationPolicy: ws,
    });
    // The TypeScript authority says "no policy"...
    const { hasAnyPolicy } = await import("@/lib/booking/policy-acknowledgement");
    expect(
      hasAnyPolicy({ cancellationPolicyText: ws, noShowPolicyText: null }),
    ).toBe(false);
    // ...so the command must not demand an acknowledgement either.
    const out = await reschedule(f, at(11, 10, 0), { ack: false, presentedHash: null });
    expect(out.result).toBe("success");
    expect(out.policy_acknowledgement_id).toBeNull();
  });

  it("still requires acknowledgement when the policy has real text around whitespace", async () => {
    const f = await seed("wsreal", { cancellationPolicy: "  \n Cancel 24h ahead. \t " });
    const out = await reschedule(f, at(11, 10, 0), { ack: false, presentedHash: null });
    expect(out.result).toBe("policy_ack_required");
  });

  it("returns policy_ack_required and mutates nothing when the box is not ticked", async () => {
    const f = await seed("ackreq", { cancellationPolicy: "Cancel 24h ahead." });
    const out = await reschedule(f, at(11, 10, 0), { ack: false });
    expect(out.result).toBe("policy_ack_required");
    await expectUnchanged(f);
    const acks = await adminQuery(
      `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
      [f.studioId],
    );
    expect(acks.rows[0].n).toBe(0);
  });

  it("returns policy_changed when the studio edits the policy after the page rendered", async () => {
    const f = await seed("changed", { cancellationPolicy: "Version A." });
    const presented = await currentPolicyHash(f.studioId); // hash A, as displayed

    await adminQuery(
      `update public.studios set cancellation_policy_text = 'Version B.' where id = $1`,
      [f.studioId],
    );

    const out = await reschedule(f, at(11, 10, 0), { ack: true, presentedHash: presented });
    expect(out.result).toBe("policy_changed");
    await expectUnchanged(f);
    const acks = await adminQuery(
      `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
      [f.studioId],
    );
    expect(acks.rows[0].n).toBe(0);
  });

  it("treats a MISSING presented hash as a mismatch, never as consent", async () => {
    const f = await seed("nohash", { cancellationPolicy: "Cancel 24h ahead." });
    const out = await reschedule(f, at(11, 10, 0), { ack: true, presentedHash: null });
    expect(out.result).toBe("policy_changed");
    await expectUnchanged(f);
  });

  it("writes exactly one acknowledgement, atomically, when the hash matches", async () => {
    const f = await seed("ackok", {
      cancellationPolicy: "Cancel 24h ahead.",
      noShowPolicy: "No-shows are charged.",
    });
    const presented = await currentPolicyHash(f.studioId);
    const out = await reschedule(f, at(11, 10, 0), { ack: true, presentedHash: presented });
    expect(out.result).toBe("success");
    expect(out.policy_acknowledgement_id).toBeTruthy();

    const acks = (
      await adminQuery(
        `select * from public.appointment_policy_acknowledgements where studio_id = $1`,
        [f.studioId],
      )
    ).rows;
    expect(acks).toHaveLength(1);
    expect(acks[0].id).toBe(out.policy_acknowledgement_id);
    expect(acks[0].action).toBe("reschedule");
    // Linked to the ORIGINAL — "the client accepted before rescheduling X".
    expect(acks[0].appointment_id).toBe(f.originalId);
    expect(acks[0].client_id).toBe(f.clientId);
    expect(acks[0].cancellation_policy_text_snapshot).toBe("Cancel 24h ahead.");
    expect(acks[0].no_show_policy_text_snapshot).toBe("No-shows are charged.");
    expect(acks[0].policy_snapshot_hash).toBe(presented);
    expect(acks[0].policy_snapshot_hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------

describe("0171 — SQL/TypeScript policy hash parity", () => {
  const CASES: Array<[string, string | null, string | null]> = [
    ["both null", null, null],
    ["both empty", "", ""],
    ["whitespace only", "   ", "\t\n"],
    ["cancellation only", "Cancel 24h ahead.", null],
    ["no-show only", null, "No-shows are charged."],
    ["multiline", "Line one\nLine two\nLine three", "A\nB"],
    ["CRLF (browser textarea)", "Line one\r\nLine two", "A\r\nB"],
    ["unicode en dash", "Arrive 10–15 minutes early", "Café — no-show fee"],
    ["emoji", "Policy 😀 applies", "Fee 💸 applies"],
    ["punctuation + quotes", `He said "no" — don't be late.`, "50% fee; no refunds."],
    ["trailing whitespace", "Cancel 24h ahead.   ", "Fee applies.\t"],
    ["separator lookalike in text", "before\n---\nafter", "x"],
  ];

  it.each(CASES)("matches for %s", async (_label, cancellation, noShow) => {
    const ts = buildPolicySnapshot({
      cancellationPolicyText: cancellation,
      noShowPolicyText: noShow,
    }).policySnapshotHash;

    // The EXACT expression migration 0171 uses.
    const sql = await adminQuery(
      `select encode(
                extensions.digest(
                  coalesce($1::text,'') || E'\\n---\\n' || coalesce($2::text,''),
                  'sha256'),
                'hex') as h`,
      [cancellation, noShow],
    );
    expect(sql.rows[0].h).toBe(ts);

    // And Node's own crypto, as a third independent witness.
    const node = createHash("sha256")
      .update(`${cancellation ?? ""}\n---\n${noShow ?? ""}`, "utf8")
      .digest("hex");
    expect(sql.rows[0].h).toBe(node);
  });
});

// ---------------------------------------------------------------------------

describe("0171 — token and lifecycle refusals", () => {
  it("collapses an unknown appointment id", async () => {
    const f = await seed("unknownid");
    const out = await reschedule(f, at(11, 10, 0), { appointmentId: randomUUID() });
    expect(out.result).toBe("appointment_not_found");
    await expectUnchanged(f);
  });

  it("collapses a wrong token hash to the SAME code as an unknown id", async () => {
    const f = await seed("wrongtoken");
    const out = await reschedule(f, at(11, 10, 0), { tokenHash: hash64() });
    expect(out.result).toBe("appointment_not_found");
    await expectUnchanged(f);
  });

  it("refuses a token belonging to a DIFFERENT appointment", async () => {
    const f = await seed("crosstoken");
    const otherHash = hash64();
    await adminQuery(
      `insert into public.appointments
         (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
          duration_minutes, status, cancellation_token_hash)
       values ($1,$2,$3,$4,$5, $5::timestamptz + make_interval(mins => 45), 45,
               'confirmed', $6)`,
      [f.studioId, f.ownerId, f.clientId, f.serviceId, at(20, 9, 0), otherHash],
    );
    const out = await reschedule(f, at(11, 10, 0), { tokenHash: otherHash });
    expect(out.result).toBe("appointment_not_found");
    await expectUnchanged(f);
  });

  it.each(["cancelled", "completed", "no_show"])(
    "refuses a %s original",
    async (status) => {
      const f = await seed(`state-${status}`);
      await adminQuery(`update public.appointments set status = $2 where id = $1`, [
        f.originalId,
        status,
      ]);
      const out = await reschedule(f, at(11, 10, 0));
      expect(out.result).toBe("appointment_not_reschedulable");
    },
  );

  it("refuses an original that has already started", async () => {
    const f = await seed("past");
    await adminQuery(
      `update public.appointments
          set starts_at = now() - interval '2 hours',
              ends_at   = now() - interval '1 hour'
        where id = $1`,
      [f.originalId],
    );
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("appointment_not_reschedulable");
  });

  it("refuses a malformed successor token hash before touching anything", async () => {
    const f = await seed("badhash");
    const out = await reschedule(f, at(11, 10, 0), { newHash: "not-a-sha256" });
    expect(out.result).toBe("invalid_time");
    await expectUnchanged(f);
  });

  it("refuses a start outside the booking horizon", async () => {
    const f = await seed("horizon");
    const out = await reschedule(f, at(200, 10, 0));
    expect(out.result).toBe("outside_horizon");
    await expectUnchanged(f);
  });

  it("refuses when the client has been archived", async () => {
    const f = await seed("archived");
    await adminQuery(`update public.clients set archived_at = now() where id = $1`, [f.clientId]);
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("appointment_not_reschedulable");
    await expectUnchanged(f);
  });

  it("a SECOND submit with the original token creates no second successor", async () => {
    const f = await seed("duplicate");
    const first = await reschedule(f, at(11, 10, 0));
    expect(first.result).toBe("success");

    const second = await reschedule(f, at(12, 10, 0));
    expect(second.result).toBe("appointment_not_reschedulable");

    const n = await adminQuery(
      `select count(*)::int n from public.appointments where studio_id = $1`,
      [f.studioId],
    );
    expect(n.rows[0].n).toBe(2); // original + exactly one successor

    const acks = await adminQuery(
      `select count(*)::int n from public.appointment_audit
        where appointment_id in ($1, $2)`,
      [f.originalId, first.new_appointment_id],
    );
    expect(acks.rows[0].n).toBe(2); // no duplicate audits
  });
});

// ---------------------------------------------------------------------------

// ===========================================================================
// FINANCIAL SAFETY — the gate must FAIL CLOSED, and these tests must be able
// to fail.
// ===========================================================================
//
// An earlier revision of the appointment_payments test wrapped its fixture in a
// `.catch()` that fell back to asserting an ORDINARY successful reschedule, and
// then returned early when the payment row was absent. That test could pass
// without the `exists (select 1 from appointment_payments ...)` arm ever being
// evaluated — a vacuous pass dressed as coverage. A fixture failure must FAIL
// the test, never convert it into a passing alternate path.
//
// So `seedAppointmentPayment` seeds the real FK lineage, with no catch:
//   studio_payment_settings(studio_id, stripe_account_id, stripe_livemode)
//     <- pending_booking_payment_sessions(id, client_id, studio_id,
//          stripe_account_id, stripe_livemode, stripe_customer_id)
//     <- payment_consents(id, pending_booking_payment_session_id, client_id,
//          studio_id)
//     <- appointment_payments
// and every test asserts the row EXISTS before invoking the command.

/**
 * Seeds the Stripe account + customer lineage every payment table hangs off:
 *   studio_payment_settings(studio_id, stripe_account_id, stripe_livemode)
 *   client_stripe_customers(client_id, studio_id, account, mode, customer)
 * Returns the identifiers so callers can build on it. Throws on any FK failure.
 */
async function seedStripeLineage(
  f: Fixture,
): Promise<{ acct: string; cus: string }> {
  const acct = `acct_${randomUUID().slice(0, 8)}`;
  const cus = `cus_${randomUUID().slice(0, 8)}`;
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_livemode, stripe_charges_enabled,
        stripe_payouts_enabled, require_card_on_file, default_charge_currency)
     values ($1,$2,false,true,true,true,'cad')`,
    [f.studioId, acct],
  );
  await adminQuery(
    `insert into public.client_stripe_customers
       (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
     values ($1,$2,$3,false,$4)`,
    [f.clientId, f.studioId, acct, cus],
  );
  return { acct, cus };
}

/** Seeds a genuinely valid appointment_payments row. Throws on any FK failure. */
async function seedAppointmentPayment(
  f: Fixture,
  paymentStatus = "method_saved",
): Promise<void> {
  const { acct, cus } = await seedStripeLineage(f);
  const sessionId = randomUUID();
  const consentId = randomUUID();

  await adminQuery(
    `insert into public.pending_booking_payment_sessions
       (id, token_hash, studio_id, service_id, client_id, requested_starts_at,
        requested_ends_at, requested_duration_minutes, stripe_account_id,
        stripe_livemode, stripe_customer_id, status)
     values ($1,$2,$3,$4,$5, now() + interval '10 days',
             now() + interval '10 days' + interval '45 minutes', 45, $6, false, $7, 'pending')`,
    [sessionId, hash64(), f.studioId, f.serviceId, f.clientId, acct, cus],
  );
  await adminQuery(
    `insert into public.payment_consents
       (id, pending_booking_payment_session_id, studio_id, client_id, consent_type,
        policy_version, rendered_consent_text_hash, studio_name_snapshot, accepted_at)
     values ($1,$2,$3,$4,'card_on_file_and_treatment_charge','v1',$5,'Harness Studio', now())`,
    [consentId, sessionId, f.studioId, f.clientId, hash64()],
  );
  await adminQuery(
    `insert into public.appointment_payments
       (appointment_id, studio_id, client_id, pending_booking_payment_session_id,
        payment_consent_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_setup_intent_id, stripe_payment_method_id, payment_status)
     values ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10)`,
    [
      f.originalId,
      f.studioId,
      f.clientId,
      sessionId,
      consentId,
      acct,
      cus,
      `seti_${randomUUID().slice(0, 12)}`,
      `pm_${randomUUID().slice(0, 12)}`,
      paymentStatus,
    ],
  );
}

describe("0171 — financial safety fails closed (appointment_payments)", () => {
  it.each([
    "method_saved",
    "charged",
    "authentication_required",
    "refunded",
    "disputed",
  ])("refuses when a VALID appointment_payments row exists with status %s", async (status) => {
    const f = await seed(`paid-${status}`);
    // No .catch(): a fixture failure fails the test.
    await seedAppointmentPayment(f, status);

    // The gate cannot be vacuous — the row is proven present first.
    const exists = await adminQuery(
      `select count(*)::int n from public.appointment_payments where appointment_id = $1`,
      [f.originalId],
    );
    expect(exists.rows[0].n).toBe(1);

    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("payment_state_requires_studio");
    await expectUnchanged(f);

    // And no evidence of a partial mutation.
    const audits = await adminQuery(
      `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
      [f.originalId],
    );
    expect(audits.rows[0].n).toBe(0);
    const acks = await adminQuery(
      `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
      [f.studioId],
    );
    expect(acks.rows[0].n).toBe(0);
  });

  it("the SAME studio reschedules fine once no payment row is attached (control)", async () => {
    const f = await seed("paid-control");
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");
  });
});

describe("0171 — financial safety fails closed (payment_charge_attempts)", () => {
  async function seedChargeAttempt(f: Fixture, status: string, reason = "no_show_fee") {
    await adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode)
       values ($1,$2,$3,$4,$5,5000,'cad',$6,false)`,
      [f.studioId, reason, f.clientId, f.originalId, f.ownerId, status],
    );
    const n = await adminQuery(
      `select count(*)::int n from public.payment_charge_attempts where appointment_id = $1`,
      [f.originalId],
    );
    expect(n.rows[0].n).toBe(1);
  }

  it.each(["ready", "blocked", "pending_stripe", "succeeded"])(
    "REFUSES on a live charge attempt in status %s",
    async (status) => {
      const f = await seed(`charge-live-${status}`);
      await seedChargeAttempt(f, status);
      const out = await reschedule(f, at(11, 10, 0));
      expect(out.result).toBe("payment_state_requires_studio");
      await expectUnchanged(f);
    },
  );

  it.each(["cancelled", "failed"])(
    "does NOT block on a terminally dead attempt in status %s",
    async (status) => {
      const f = await seed(`charge-dead-${status}`);
      await seedChargeAttempt(f, status);
      const out = await reschedule(f, at(11, 10, 0));
      expect(out.result).toBe("success");
    },
  );
});

describe("0171 — financial safety fails closed (manual_fee_charge_attempts)", () => {
  // The full lineage this table demands, seeded for real:
  //   studio_payment_settings + client_stripe_customers (via seedStripeLineage)
  //     <- client_consent_signatures      (card authorization)
  //     <- client_payment_methods         (customer lineage FK)
  //     <- appointment_policy_acknowledgements
  //     <- manual_fee_charge_attempts
  // No .catch() anywhere: a fixture failure fails the test.
  async function seedManualFee(f: Fixture, status: string) {
    const { acct, cus } = await seedStripeLineage(f);
    const sigId = randomUUID();
    const pmId = randomUUID();
    const ackId = randomUUID();

    const templateId = randomUUID();
    await adminQuery(
      `insert into public.consent_form_templates
         (id, studio_id, title, body, form_type, version, status, is_live)
       values ($1,$2,'Card authorization','Body','card_authorization',1,'active',true)`,
      [templateId, f.studioId],
    );
    await adminQuery(
      `insert into public.client_consent_signatures
         (id, studio_id, client_id, template_id, template_title_snapshot,
          template_body_snapshot, template_version, template_hash, signature_name,
          signed_at, response)
       values ($1,$2,$3,$4,'Card authorization','Body',1,$5,'Test Client', now(),'accepted')`,
      [sigId, f.studioId, f.clientId, templateId, hash64()],
    );
    await adminQuery(
      `insert into public.client_payment_methods
         (id, studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
          stripe_payment_method_id, stripe_setup_intent_id, card_authorization_signature_id,
          brand, last4, exp_month, exp_year)
       values ($1,$2,$3,$4,false,$5,$6,$7,$8,'visa','4242',12,2030)`,
      [pmId, f.studioId, f.clientId, acct, cus, `pm_${randomUUID().slice(0, 10)}`,
       `seti_${randomUUID().slice(0, 10)}`, sigId],
    );
    await adminQuery(
      `insert into public.appointment_policy_acknowledgements
         (id, studio_id, appointment_id, client_id, action,
          cancellation_policy_text_snapshot, no_show_policy_text_snapshot, policy_snapshot_hash)
       values ($1,$2,$3,$4,'cancel','p','q',$5)`,
      [ackId, f.studioId, f.originalId, f.clientId, hash64()],
    );
    await adminQuery(
      `insert into public.manual_fee_charge_attempts
         (studio_id, appointment_id, client_id, confirmed_by_practitioner_id, charge_type,
          amount_cents, currency, status, client_payment_method_id,
          card_authorization_signature_id, appointment_policy_acknowledgement_id,
          policy_snapshot_hash, internal_note, timing_classification, stripe_livemode)
       values ($1,$2,$3,$4,'no_show',5000,'cad',$5,$6,$7,$8,$9,'note','practitioner_asserted',false)`,
      [f.studioId, f.originalId, f.clientId, f.ownerId, status, pmId, sigId, ackId, hash64()],
    );
    const n = await adminQuery(
      `select count(*)::int n from public.manual_fee_charge_attempts where appointment_id = $1`,
      [f.originalId],
    );
    expect(n.rows[0].n).toBe(1);
  }

  it.each(["ready", "blocked", "pending_stripe", "succeeded"])(
    "REFUSES on a live manual fee attempt in status %s",
    async (status) => {
      const f = await seed(`fee-live-${status}`);
      await seedManualFee(f, status);
      const out = await reschedule(f, at(11, 10, 0));
      expect(out.result).toBe("payment_state_requires_studio");
      await expectUnchanged(f);
    },
  );

  it.each(["cancelled", "failed"])(
    "does NOT block on a terminally dead manual fee attempt in status %s",
    async (status) => {
      const f = await seed(`fee-dead-${status}`);
      await seedManualFee(f, status);
      const out = await reschedule(f, at(11, 10, 0));
      expect(out.result).toBe("success");
    },
  );
});

describe("0171 — the financial census is complete", () => {
  it("no OTHER table carrying live appointment-bound money is missing from the gate", async () => {
    // Every table with an appointment_id FK, minus the ones the gate covers and
    // the ones that are provably not payment state. If this list grows, the
    // gate (or this justification) must be revisited.
    const r = await adminQuery(
      `select distinct c.conrelid::regclass::text as t
         from pg_constraint c
        where c.contype = 'f'
          and c.confrelid = 'public.appointments'::regclass`,
    );
    const referencing = r.rows.map((x: { t: string }) => x.t).sort();
    expect(referencing).toEqual(
      [
        // Covered BY THE GATE:
        "appointment_payments",
        "manual_fee_charge_attempts",
        "payment_charge_attempts",
        // Not payment state:
        "appointment_audit", //            evidence, stays on the original
        "appointment_policy_acknowledgements", // evidence, stays on the original
        "appointments", //                 the lineage self-reference
        "booking_tracking_consents", //    marketing consent, ON DELETE SET NULL
        "ops_alerts", //                   operator signal, ON DELETE SET NULL
        "practitioner_notifications", //   in-app notice, ON DELETE SET NULL
        "sessions", //                     clinical record, ON DELETE SET NULL
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------

describe("0171 — practitioner continuity", () => {
  it("preserves a NULL practitioner under capacity OFF", async () => {
    const f = await seed("nullpract");
    await adminQuery(`update public.appointments set practitioner_id = null where id = $1`, [
      f.originalId,
    ]);
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");
    expect(out.practitioner_id).toBeNull();
    const succ = (
      await adminQuery(`select practitioner_id from public.appointments where id = $1`, [
        out.new_appointment_id,
      ])
    ).rows[0];
    expect(succ.practitioner_id).toBeNull();
  });

  it("never reassigns to a newly-added owner — the ORIGINAL practitioner is kept", async () => {
    const f = await seed("noreassign");
    // A second, newer active owner appears. A "current active owner" lookup
    // could pick either; the command must pick neither.
    const otherUser = randomUUID();
    const otherPract = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
      otherUser,
      `other-${otherPract.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Other','o@harness.local','owner',true)`,
      [otherPract, f.studioId, otherUser],
    );

    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");
    expect(out.practitioner_id).toBe(f.ownerId);
    expect(out.practitioner_id).not.toBe(otherPract);
  });

  // ==========================================================================
  // CAPACITY-OFF HISTORICAL ASSIGNMENT — the parity contract.
  // ==========================================================================
  //
  // The capacity-OFF slot loader generates from STUDIO-WIDE availability and
  // STUDIO-WIDE reservations and never consults practitioner activity or
  // service_practitioners. An earlier revision of validate_public_reschedule_slot
  // gated membership/eligibility on `p_practitioner_id is not null` (0170's form,
  // correct for booking), which meant a capacity-OFF studio whose original
  // practitioner had since been deactivated — or dropped from the service's
  // eligibility list — had the page offer slots the validator refused EVERY one
  // of. Public rescheduling was permanently unsatisfiable for that client.
  it("capacity OFF: preserves an INACTIVE historical practitioner and still reschedules", async () => {
    const f = await seed("offinactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.ownerId]);

    const target = at(11, 10, 0);

    // The validator must clear the slot the page would offer.
    const verdict = await adminQuery(
      `select public.validate_public_reschedule_slot($1,$2,$3,$4::timestamptz,
                $4::timestamptz + make_interval(mins => 45), $5) as v`,
      [f.studioId, f.ownerId, f.serviceId, target, f.originalId],
    );
    expect(verdict.rows[0].v).toBe("ok");

    const out = await reschedule(f, target);
    expect(out.result).toBe("success");
    // The inactive practitioner is CARRIED THROUGH, not dropped and not swapped.
    expect(out.practitioner_id).toBe(f.ownerId);
    const succ = (
      await adminQuery(`select practitioner_id from public.appointments where id = $1`, [
        out.new_appointment_id,
      ])
    ).rows[0];
    expect(succ.practitioner_id).toBe(f.ownerId);
  });

  it("capacity OFF: preserves a practitioner dropped from the service eligibility list", async () => {
    const f = await seed("offineligible");
    const otherUser = randomUUID();
    const otherPract = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
      otherUser,
      `offelig-${otherPract.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Other','oe@harness.local','practitioner',true)`,
      [otherPract, f.studioId, otherUser],
    );
    // Non-empty eligibility list that EXCLUDES the original practitioner.
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1,$2,$3) on conflict do nothing`,
      [f.studioId, f.serviceId, otherPract],
    );
    await adminQuery(
      `delete from public.service_practitioners where service_id = $1 and practitioner_id = $2`,
      [f.serviceId, f.ownerId],
    );

    const target = at(11, 10, 0);
    const verdict = await adminQuery(
      `select public.validate_public_reschedule_slot($1,$2,$3,$4::timestamptz,
                $4::timestamptz + make_interval(mins => 45), $5) as v`,
      [f.studioId, f.ownerId, f.serviceId, target, f.originalId],
    );
    expect(verdict.rows[0].v).toBe("ok");

    const out = await reschedule(f, target);
    expect(out.result).toBe("success");
    expect(out.practitioner_id).toBe(f.ownerId);
  });

  it("capacity ON: the SAME inactive practitioner IS refused (the gate is mode-scoped, not removed)", async () => {
    const f = await seed("oninactive-contrast", { capacity: true });
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.ownerId]);
    const verdict = await adminQuery(
      `select public.validate_public_reschedule_slot($1,$2,$3,$4::timestamptz,
                $4::timestamptz + make_interval(mins => 45), $5) as v`,
      [f.studioId, f.ownerId, f.serviceId, at(11, 10, 0), f.originalId],
    );
    expect(verdict.rows[0].v).toBe("invalid_practitioner");
  });

  it("refuses under capacity ON when the preserved practitioner is inactive", async () => {
    const f = await seed("inactivepract", { capacity: true });
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.ownerId]);
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("practitioner_unavailable");
    await expectUnchanged(f);
  });

  it("refuses under capacity ON when the preserved practitioner is not eligible for the service", async () => {
    const f = await seed("ineligible", { capacity: true });
    const otherUser = randomUUID();
    const otherPract = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
      otherUser,
      `elig-${otherPract.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Elig','e@harness.local','practitioner',true)`,
      [otherPract, f.studioId, otherUser],
    );
    // The service now has an eligibility list that EXCLUDES the original owner.
    // The service already HAS an eligibility list (rows are fanned out when a
    // practitioner/service is created), so make it exclude the original owner
    // by removing their row — leaving the list non-empty, which is the
    // precondition the eligibility gate keys on.
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1,$2,$3)
       on conflict do nothing`,
      [f.studioId, f.serviceId, otherPract],
    );
    await adminQuery(
      `delete from public.service_practitioners
        where service_id = $1 and practitioner_id = $2`,
      [f.serviceId, f.ownerId],
    );
    const remaining = await adminQuery(
      `select count(*)::int n from public.service_practitioners where service_id = $1`,
      [f.serviceId],
    );
    expect(remaining.rows[0].n).toBeGreaterThan(0);
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("practitioner_unavailable");
    await expectUnchanged(f);
  });
});

// ---------------------------------------------------------------------------

describe("0171 — Google Calendar invariants", () => {
  it("enqueues NOTHING while outbound intent is OFF", async () => {
    const f = await seed("gcaloff");
    const before = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
      [f.studioId],
    );
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    const after = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
      [f.studioId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const links = await adminQuery(
      `select count(*)::int n from public.calendar_event_links where studio_id = $1`,
      [f.studioId],
    );
    expect(links.rows[0].n).toBe(0);
  });

  it("sets cancellation_kind='rescheduled' in the SAME update that cancels, so no delete can be enqueued", async () => {
    const f = await seed("gcalkind");
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");

    const orig = (
      await adminQuery(
        `select status, cancellation_kind from public.appointments where id = $1`,
        [f.originalId],
      )
    ).rows[0];
    expect(orig.status).toBe("cancelled");
    expect(orig.cancellation_kind).toBe("rescheduled");

    // enqueue_calendar_outbound returns early on exactly this pair, so even
    // with a connection present no event.delete could be produced.
    const deletes = await adminQuery(
      `select count(*)::int n from public.calendar_sync_outbox
        where hone_entity_id = $1 and op_type = 'event.delete'`,
      [f.originalId],
    );
    expect(deletes.rows[0].n).toBe(0);
  });

  it("sets rescheduled_from_appointment_id so the dormant link rebind can fire", async () => {
    const f = await seed("gcallineage");
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");
    const succ = (
      await adminQuery(
        `select rescheduled_from_appointment_id from public.appointments where id = $1`,
        [out.new_appointment_id],
      )
    ).rows[0];
    expect(succ.rescheduled_from_appointment_id).toBe(f.originalId);
  });
});

// ---------------------------------------------------------------------------

// ===========================================================================
// SUCCESSOR TOKEN HASH COLLISION
// ===========================================================================
//
// appointments.cancellation_token_hash carries a partial unique index. The
// generated token is high entropy so a real collision is vanishingly unlikely,
// but the FAILURE CONTRACT still has to be explicit rather than accidental:
// there is deliberately NO automatic retry (a retry would have to prove the
// original was not already mutated, which is a design this PR does not add).
describe("0171 — successor token hash collision", () => {
  it("rolls the whole command back and leaves the original untouched", async () => {
    const f = await seed("collision");
    // Park the hash on another appointment so the successor INSERT collides.
    const takenHash = hash64();
    await adminQuery(
      `insert into public.appointments
         (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
          duration_minutes, status, cancellation_token_hash)
       values ($1,$2,$3,$4,$5, $5::timestamptz + make_interval(mins => 45), 45,
               'confirmed', $6)`,
      [f.studioId, f.ownerId, f.clientId, f.serviceId, at(30, 9, 0), takenHash],
    );

    // The unique violation must surface as a RAISED error (23505) that rolls
    // back, not as a closed result code that pretends the reschedule happened.
    await expect(
      reschedule(f, at(11, 10, 0), { newHash: takenHash }),
    ).rejects.toThrow(/duplicate key|unique/i);

    await expectUnchanged(f);

    // No audit, no acknowledgement, no successor.
    const audits = await adminQuery(
      `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
      [f.originalId],
    );
    expect(audits.rows[0].n).toBe(0);

    // The colliding hash still belongs to exactly ONE appointment — the other
    // one — so nothing was overwritten.
    const owners = await adminQuery(
      `select count(*)::int n from public.appointments where cancellation_token_hash = $1`,
      [takenHash],
    );
    expect(owners.rows[0].n).toBe(1);
  });

  it("a FRESH hash on the same fixture succeeds (control)", async () => {
    const f = await seed("collision-control");
    const out = await reschedule(f, at(11, 10, 0), { newHash: hash64() });
    expect(out.result).toBe("success");
  });
});

// ===========================================================================
// SUCCESS-ROW INTEGRITY — the contract the application's parser relies on.
// ===========================================================================
describe("0171 — a success row is structurally non-null", () => {
  it("populates every field the application requires", async () => {
    const f = await seed("successshape");
    const out = await reschedule(f, at(11, 10, 0));
    expect(out.result).toBe("success");
    for (const field of [
      "original_appointment_id",
      "new_appointment_id",
      "studio_id",
      "client_id",
      "original_starts_at",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "created_at",
    ] as const) {
      expect(out[field], `${field} must be non-null on success`).not.toBeNull();
      expect(out[field]).not.toBeUndefined();
    }
    expect(out.duration_minutes as number).toBeGreaterThan(0);
  });

  it("a REFUSAL row carries nulls in every field but result", async () => {
    const f = await seed("refusalshape");
    const out = await reschedule(f, f.originalStart); // same_time
    expect(out.result).toBe("same_time");
    for (const field of [
      "original_appointment_id",
      "new_appointment_id",
      "studio_id",
      "client_id",
      "service_id",
      "practitioner_id",
      "original_starts_at",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "created_at",
      "policy_acknowledgement_id",
    ] as const) {
      expect(out[field], `${field} must be null on a refusal`).toBeNull();
    }
  });
});

describe("0171 — privilege boundary", () => {
  it.each(["anon", "authenticated"] as const)("denies EXECUTE to %s", async (role) => {
    await expect(
      asRole(role, async (q) => {
        await q(
          `select * from public.reschedule_appointment_v2($1,$2,now(),$3,true,null)`,
          [randomUUID(), "x".repeat(64), "a".repeat(64)],
        );
      }),
    ).rejects.toThrow(/permission denied|42501/i);
  });

  it.each(["anon", "authenticated"] as const)(
    "denies EXECUTE on the candidate helper to %s",
    async (role) => {
      await expect(
        asRole(role, async (q) => {
          await q(
            `select * from public.public_reschedule_slot_candidates($1, current_date, 45, null, null)`,
            [randomUUID()],
          );
        }),
      ).rejects.toThrow(/permission denied|42501/i);
    },
  );

  it.each(["anon", "authenticated"] as const)(
    "denies EXECUTE on the reschedule validator to %s",
    async (role) => {
      await expect(
        asRole(role, async (q) => {
          await q(
            `select public.validate_public_reschedule_slot($1, null, null, now(), now(), null)`,
            [randomUUID()],
          );
        }),
      ).rejects.toThrow(/permission denied|42501/i);
    },
  );

  // RETIRED (B6 / 0175). This asserted the legacy v1 `reschedule_appointment`
  // remained INSTALLED for deployment skew. B6 dropped it by exact signature
  // after a zero-caller census, so the claim is not merely false — the object
  // it referred to is gone. The exact DROP is pinned in
  // tests/migrations/0175-appointment-transition-integrity.test.ts and its
  // absence is proven in tests/db/appointment-transition-integrity.db.test.ts,
  // so no replacement assertion is added here.

  it("after 0172 the appointments table leaves both browser roles with SELECT only", async () => {
    // Was "revokes NOTHING from the appointments table". 0171 itself still
    // revokes nothing — that remains pinned byte-level in
    // tests/migrations/0171-public-reschedule-command.test.ts. What changed is
    // the CHAIN this suite runs against: migration 0172 (appointment boundary
    // B3) now applies after 0171, so the observed posture inverts.
    const r = await adminQuery(
      `select r.rolname,
              has_table_privilege(r.oid,'public.appointments','INSERT') ins,
              has_table_privilege(r.oid,'public.appointments','UPDATE') upd,
              has_table_privilege(r.oid,'public.appointments','DELETE') del,
              has_table_privilege(r.oid,'public.appointments','TRUNCATE') trunc,
              has_table_privilege(r.oid,'public.appointments','MAINTAIN') maint,
              has_table_privilege(r.oid,'public.appointments','SELECT') sel
         from pg_roles r where r.rolname in ('anon','authenticated') order by 1`,
    );
    expect(r.rowCount, "both browser roles must be probed").toBe(2);
    for (const row of r.rows) {
      expect(row.ins, `${row.rolname} INSERT`).toBe(false);
      expect(row.upd, `${row.rolname} UPDATE`).toBe(false);
      expect(row.del, `${row.rolname} DELETE`).toBe(false);
      expect(row.trunc, `${row.rolname} TRUNCATE`).toBe(false);
      expect(row.maint, `${row.rolname} MAINTAIN`).toBe(false);
      expect(row.sel, `${row.rolname} SELECT must be retained`).toBe(true);
    }
  });

  it("the reschedule command itself keeps its service_role EXECUTE after 0172", async () => {
    // The reschedule path writes appointments as service_role. If 0172 had
    // reached service_role or the function layer, every public reschedule in
    // production would start failing.
    const r = await adminQuery(
      `select has_function_privilege('service_role', p.oid, 'EXECUTE') svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='reschedule_appointment_v2'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].svc).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * The rollback invariant, asserted after every refusal: the original is still
 * confirmed with its original token and reservation, and NO successor exists.
 */
async function expectUnchanged(f: Fixture): Promise<void> {
  const orig = (
    await adminQuery(`select * from public.appointments where id = $1`, [f.originalId])
  ).rows[0];
  expect(orig.status).toBe("confirmed");
  expect(orig.cancellation_token_hash).toBe(f.originalHash);
  expect(orig.cancelled_at).toBeNull();
  expect(orig.cancellation_kind).toBeNull();
  expect(orig.rescheduled_to_appointment_id).toBeNull();

  const successors = await adminQuery(
    `select count(*)::int n from public.appointments where rescheduled_from_appointment_id = $1`,
    [f.originalId],
  );
  expect(successors.rows[0].n).toBe(0);

  const res = await adminQuery(
    `select count(*)::int n from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = $1`,
    [f.originalId],
  );
  expect(res.rows[0].n).toBe(1);
}
