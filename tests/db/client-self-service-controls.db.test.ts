import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio } from "./helpers/harness";
import { randomUUID } from "node:crypto";
import { buildPolicySnapshot } from "@/lib/booking/policy-acknowledgement";

// ===========================================================================
// HON-47 / migration 0234 — a studio may disable CLIENT self-service
// cancellation and rescheduling, and STAFF scheduling must be untouched.
// ===========================================================================
//
// The flags are enforced INSIDE the two client-only commands, so these are the
// authoritative tests: an application-level check could be bypassed by a future
// caller, and the reason the rule lives in the database is that it cannot be.
//
// WHAT EACH CASE MUST ESTABLISH, and why a bare "it refuses" would not be
// enough:
//
//   * with the flag FALSE the command refuses AND MUTATES NOTHING — a refusal
//     that still cancelled the appointment would be worse than no control;
//   * with the flag TRUE the same call SUCCEEDS — without that control the
//     refusal might be caused by the fixture rather than by the flag;
//   * the 5-argument legacy cancel overload refuses by DELEGATION, so a future
//     un-delegation cannot drop the gate silently;
//   * STAFF cancel and move still work with BOTH flags false, because they use
//     different commands and must not inherit a client-facing rule;
//   * a studio created without naming the columns has both flags TRUE, which
//     is what makes applying 0234 a no-op for every existing studio.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

/** An instant `days` from now at `hh:mm` UTC, millisecond-clean. */
function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

type Fixture = {
  studioId: string;
  userId: string;
  ownerId: string;
  clientId: string;
  serviceId: string;
  apptId: string;
  tokenHash: string;
  startsAt: string;
};

/**
 * One studio, one owner practitioner, one client, one service, open all week,
 * and one confirmed appointment ten days out carrying a cancellation token.
 *
 */
async function seed(label: string): Promise<Fixture> {
  // The shared seeder gives the studio, its owner practitioner and a client —
  // and it inserts the studio WITHOUT naming either HON-47 column, so every
  // fixture also exercises the `not null default true` default.
  const base = await seedStudio(`hon47-${label}`);
  const studioId = base.studioId;
  const ownerId = base.practitionerId;
  const clientId = base.clientId;
  const serviceId = randomUUID();
  const apptId = randomUUID();
  const tokenHash = hash64();

  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Treatment', 45, true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );

  const startsAt = at(10, 14, 0);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => 45), 45,
             'confirmed', $7)`,
    [apptId, studioId, ownerId, clientId, serviceId, startsAt, tokenHash],
  );

  return { studioId, userId: base.userId, ownerId, clientId, serviceId, apptId, tokenHash, startsAt };
}

/** Exercise the admission authority as the fixture's owner, without bypassing its guard. */
async function chooseAdmissionMode(f: Fixture, mode: "open" | "waitlist" | "closed") {
  const { rows } = await asUser(f.userId, (query) =>
    query("select * from public.set_new_client_admission_mode($1, $2)", [
      f.studioId,
      mode,
    ]),
  );
  expect(rows[0].outcome, "the owner must establish the admission-mode precondition").toBe("ok");
  expect(rows[0].mode).toBe(mode);
}

const setFlags = (
  studioId: string,
  cancellation: boolean,
  reschedule: boolean,
): Promise<unknown> =>
  adminQuery(
    `update public.studios
        set client_cancellation_enabled = $2, client_reschedule_enabled = $3
      where id = $1`,
    [studioId, cancellation, reschedule],
  );

const status = async (apptId: string): Promise<string> =>
  (
    await adminQuery(
      `select status from public.appointments where id = $1`,
      [apptId],
    )
  ).rows[0]!.status as string;

/**
 * The appointment's start as a NORMALISED ISO string.
 *
 * node-postgres returns `timestamptz` as a Date, not a string, so comparing it
 * to an ISO string fails with two values that PRINT IDENTICALLY — which is
 * exactly how my first version read: "expected 2026-10-28T14:00:00.000Z to be
 * '2026-10-28T14:00:00.000Z'". Both sides are normalised here so a real
 * difference is the only thing that can fail.
 */
const startOf = async (apptId: string): Promise<string> =>
  new Date(
    (
      await adminQuery(
        `select starts_at from public.appointments where id = $1`,
        [apptId],
      )
    ).rows[0]!.starts_at as string | Date,
  ).toISOString();

/**
 * The canonical hash of a studio's CURRENT policy text, via the TS helper —
 * the same approach as tests/db/public-reschedule-command.db.test.ts.
 *
 * REQUIRED EVEN FOR A STUDIO WITH NO POLICY. 0176:102-104 states it: the
 * presented hash must equal the current hash "even when both describe an empty"
 * policy, so a page must ALWAYS post one. My first version of `cancel7` passed
 * an empty string, which 0176:207-208 refuses — the ENABLED control would then
 * have failed on the fixture rather than proving anything about the flag.
 */
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

/** The 7-argument cancellation command — the one the application calls. */
async function cancel7(f: Fixture): Promise<string> {
  const r = await adminQuery(
    `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5,$6,$7)`,
    [f.tokenHash, "other", "Other", null, false, false, await currentPolicyHash(f.studioId)],
  );
  return r.rows[0]!.result as string;
}

/** The 5-argument legacy overload, which delegates to the 7-argument one. */
async function cancel5(f: Fixture): Promise<string> {
  const r = await adminQuery(
    `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
    [f.tokenHash, "other", "Other", null, false],
  );
  return r.rows[0]!.result as string;
}

/** The v2 WRAPPER — the name an older app build still calls. */
async function reschedule(f: Fixture, newStart: string): Promise<string> {
  const r = await adminQuery(
    `select result from public.reschedule_appointment_v2($1,$2,$3,$4,$5,$6)`,
    [f.apptId, f.tokenHash, newStart, hash64(), true, null],
  );
  return r.rows[0]!.result as string;
}

/** v3 — the implementation, and the one the application calls. */
async function rescheduleV3(
  f: Fixture,
  newStart: string,
): Promise<Record<string, unknown>> {
  const r = await adminQuery(
    `select * from public.reschedule_appointment_v3($1,$2,$3,$4,$5,$6)`,
    [f.apptId, f.tokenHash, newStart, hash64(), true, null],
  );
  return r.rows[0]! as Record<string, unknown>;
}

afterAll(async () => {
  await closePool();
});

describe("HON-47 defaults: applying 0234 changes no studio", () => {
  it("a studio inserted without naming the columns has BOTH flags true", async () => {
    const f = await seed("defaults");
    const r = await adminQuery(
      `select client_cancellation_enabled as c, client_reschedule_enabled as s
         from public.studios where id = $1`,
      [f.studioId],
    );
    expect(r.rows[0]).toEqual({ c: true, s: true });
  });

  it("both columns are NOT NULL, so absence can never read as disabled", async () => {
    const r = await adminQuery(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name in ('client_cancellation_enabled','client_reschedule_enabled')
        order by column_name`,
      [],
    );
    expect(r.rows.map((x) => x.is_nullable)).toEqual(["NO", "NO"]);
  });
});

describe("HON-47 cancellation", () => {
  it("DISABLED: refuses with cancellation_disabled and mutates nothing", async () => {
    const f = await seed("cancel-off");
    await setFlags(f.studioId, false, true);
    expect(await cancel7(f)).toBe("cancellation_disabled");
    // The appointment is the thing that matters: a refusal that still cancelled
    // would be worse than having no control at all.
    expect(await status(f.apptId)).toBe("confirmed");
    const audits = await adminQuery(
      `select count(*)::text as n from public.appointment_audit where appointment_id = $1`,
      [f.apptId],
    );
    expect(audits.rows[0]!.n, "a refused attempt leaves no audit trace").toBe("0");
  });

  it("CONTROL — ENABLED: the identical call cancels", async () => {
    // Without this the refusal above could be caused by the fixture rather
    // than by the flag.
    const f = await seed("cancel-on");
    await setFlags(f.studioId, true, true);
    expect(await cancel7(f)).toBe("cancelled");
    expect(await status(f.apptId)).toBe("cancelled");
  });

  it("the 5-ARGUMENT LEGACY OVERLOAD refuses too, by delegation", async () => {
    // It has no gate of its own: it delegates to the 7-argument command, which
    // refuses. Pinned so a future un-delegation cannot drop the gate silently.
    const f = await seed("cancel5-off");
    await setFlags(f.studioId, false, true);
    expect(await cancel5(f)).toBe("cancellation_disabled");
    expect(await status(f.apptId)).toBe("confirmed");
  });

  it("CONTROL — the 5-argument overload still cancels when enabled", async () => {
    const f = await seed("cancel5-on");
    await setFlags(f.studioId, true, true);
    expect(await cancel5(f)).toBe("cancelled");
    expect(await status(f.apptId)).toBe("cancelled");
  });
});

describe("HON-47 rescheduling", () => {
  it("DISABLED: refuses with reschedule_disabled and mutates nothing", async () => {
    const f = await seed("resched-off");
    await setFlags(f.studioId, true, false);
    expect(await reschedule(f, at(12, 15, 0))).toBe("reschedule_disabled");
    expect(await status(f.apptId)).toBe("confirmed");
    expect(await startOf(f.apptId), "the original time must not move").toBe(
      new Date(f.startsAt).toISOString(),
    );
    const successors = await adminQuery(
      `select count(*)::text as n from public.appointments
        where rescheduled_from_appointment_id = $1`,
      [f.apptId],
    );
    expect(successors.rows[0]!.n, "no successor row may be written").toBe("0");
  });

  it("CONTROL — ENABLED: the identical call reschedules", async () => {
    const f = await seed("resched-on");
    await setFlags(f.studioId, true, true);
    // 'success', not 'rescheduled' — 0171's own word. My first guess was the
    // latter, which would have failed on vocabulary while the command worked.
    expect(await reschedule(f, at(12, 15, 0))).toBe("success");
  });
});

// ===========================================================================
// THE FLAG SPEAKS ONLY ABOUT AN APPOINTMENT THAT COULD OTHERWISE HAVE BEEN
// CHANGED — Codex P1 4308948303.
// ===========================================================================
//
// The first version of 0234 refused on the flag immediately after taking the
// studio lock, BEFORE the token and state checks. So a cancelled, completed or
// past appointment at a disabled studio was answered `cancellation_disabled`,
// and the surface then told the client "Your appointment is still booked and
// has not been changed" — FALSE for a cancelled appointment, and a distinction
// the public collapse rule deliberately refuses to make, since it reveals the
// studio's policy on a token state the surface otherwise flattens.
//
// WHY MY ORIGINAL TESTS MISSED IT, which is the part worth keeping: every
// disabled case used a CONFIRMED FUTURE appointment. The flag and the state
// were never varied together, so the ordering was untested in both directions
// and a refusal that arrived too early looked identical to one that arrived at
// the right time.
describe("HON-47 ordering: an INELIGIBLE appointment keeps its generic result", () => {
  it("CANCELLED + cancellation disabled -> already_cancelled, NOT cancellation_disabled", async () => {
    const f = await seed("order-cancelled");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments set status = 'cancelled' where id = $1`,
      [f.apptId],
    );
    expect(await cancel7(f)).toBe("already_cancelled");
  });

  it("PAST + cancellation disabled -> not_cancelable, NOT cancellation_disabled", async () => {
    const f = await seed("order-past");
    await setFlags(f.studioId, false, false);
    // Moved into the past directly: the command compares starts_at to now(),
    // and the insert carries no future constraint.
    await adminQuery(
      `update public.appointments
          set starts_at = now() - interval '2 hours',
              ends_at = now() - interval '75 minutes'
        where id = $1`,
      [f.apptId],
    );
    expect(await cancel7(f)).toBe("not_cancelable");
  });

  it("COMPLETED + cancellation disabled -> not_cancelable", async () => {
    const f = await seed("order-completed");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments set status = 'completed' where id = $1`,
      [f.apptId],
    );
    expect(await cancel7(f)).toBe("not_cancelable");
  });

  it("an UNKNOWN token at a disabled studio stays invalid_token", async () => {
    // The strongest form of the leak: the flag must not be readable by someone
    // holding no valid token at all.
    const f = await seed("order-unknown");
    await setFlags(f.studioId, false, false);
    const r = await adminQuery(
      `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5,$6,$7)`,
      [hash64(), "other", "Other", null, false, false, await currentPolicyHash(f.studioId)],
    );
    expect(r.rows[0]!.result).toBe("invalid_token");
  });

  it("the 5-ARGUMENT overload inherits the ordering too", async () => {
    const f = await seed("order-cancel5");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments set status = 'cancelled' where id = $1`,
      [f.apptId],
    );
    expect(await cancel5(f)).toBe("already_cancelled");
  });

  // THE SAME DEFECT WAS ON THE RESCHEDULE PATH, and was not in the report.
  // Codex raised the cancel command; `reschedule_appointment_v2` refused on its
  // flag right after the studio lock as well, so a cancelled or past
  // appointment at a reschedule-disabled studio was told "your appointment is
  // still booked at its original time".
  it("CANCELLED + reschedule disabled -> appointment_not_reschedulable", async () => {
    const f = await seed("order-res-cancelled");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments set status = 'cancelled' where id = $1`,
      [f.apptId],
    );
    expect(await reschedule(f, at(12, 15, 0))).toBe(
      "appointment_not_reschedulable",
    );
  });

  it("PAST + reschedule disabled -> appointment_not_reschedulable", async () => {
    const f = await seed("order-res-past");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments
          set starts_at = now() - interval '2 hours',
              ends_at = now() - interval '75 minutes'
        where id = $1`,
      [f.apptId],
    );
    expect(await reschedule(f, at(12, 15, 0))).toBe(
      "appointment_not_reschedulable",
    );
  });

  it("a WRONG token at a reschedule-disabled studio stays appointment_not_found", async () => {
    const f = await seed("order-res-token");
    await setFlags(f.studioId, false, false);
    const r = await adminQuery(
      `select result from public.reschedule_appointment_v2($1,$2,$3,$4,$5,$6)`,
      [f.apptId, hash64(), at(12, 15, 0), hash64(), true, null],
    );
    expect(r.rows[0]!.result).toBe("appointment_not_found");
  });

  // AND THE CONTROLS, so none of the above can pass because the flag stopped
  // working altogether: with the SAME flags off and an ELIGIBLE appointment,
  // both commands still refuse on the flag.
  it("CONTROL — eligible + disabled still refuses on the FLAG, both commands", async () => {
    const a = await seed("order-ctl-cancel");
    await setFlags(a.studioId, false, false);
    expect(await cancel7(a)).toBe("cancellation_disabled");

    const b = await seed("order-ctl-res");
    await setFlags(b.studioId, false, false);
    expect(await reschedule(b, at(12, 15, 0))).toBe("reschedule_disabled");
  });
});

// ===========================================================================
// v3 RETURNS THE FLAGS IT READ UNDER THE LOCK — Codex P2 4309167887.
// ===========================================================================
//
// The action used to build the SUCCESSOR's links from a studio row read BEFORE
// the command. A flag flipped in between produced a confirmation carrying a
// fresh cancel link that refused on first use. v3 returns what it read under
// the studio lock, which is the only read that cannot be stale.
describe("HON-47 v3's success payload carries both flags", () => {
  it("both ON: the payload reports both as true", async () => {
    const f = await seed("v3-both-on");
    await setFlags(f.studioId, true, true);
    const row = await rescheduleV3(f, at(12, 15, 0));
    expect(row.result).toBe("success");
    expect(row.client_cancellation_enabled).toBe(true);
    expect(row.client_reschedule_enabled).toBe(true);
  });

  it("CANCELLATION OFF, rescheduling ON: it succeeds AND reports cancellation false", async () => {
    // THE CASE THAT MATTERS. The reschedule must still work — cancellation
    // being off is not a reason to refuse a move — and the payload must carry
    // the false so the caller withholds the successor's cancel link.
    const f = await seed("v3-cancel-off");
    await setFlags(f.studioId, false, true);
    const row = await rescheduleV3(f, at(12, 15, 0));
    expect(row.result).toBe("success");
    expect(
      row.client_cancellation_enabled,
      "the successor's cancel link depends on this value",
    ).toBe(false);
    expect(row.client_reschedule_enabled).toBe(true);
  });

  it("a REFUSAL carries nulls, not a stale or invented value", async () => {
    const f = await seed("v3-refusal-nulls");
    await setFlags(f.studioId, true, false);
    const row = await rescheduleV3(f, at(12, 15, 0));
    expect(row.result).toBe("reschedule_disabled");
    // There is no successor on a refusal, so there is nothing to link and the
    // flags must not be reported as though there were.
    expect(row.client_cancellation_enabled).toBeNull();
    expect(row.client_reschedule_enabled).toBeNull();
  });
});

// ===========================================================================
// THE v2 WRAPPER — the DEPLOY-SKEW promise.
// ===========================================================================
//
// 0234 is applied BEFORE the build that calls v3 goes live (migration-first),
// so there is a window in which the running app still calls v2. These cases are
// that window: v2 must keep its original shape and still inherit the gate.
describe("HON-47 v2 remains a faithful wrapper over v3", () => {
  it("returns EXACTLY the original thirteen columns, by name", async () => {
    const f = await seed("v2-shape");
    await setFlags(f.studioId, true, true);
    const r = await adminQuery(
      `select * from public.reschedule_appointment_v2($1,$2,$3,$4,$5,$6)`,
      [f.apptId, f.tokenHash, at(12, 15, 0), hash64(), true, null],
    );
    expect(Object.keys(r.rows[0]!)).toEqual([
      "result",
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
    ]);
    // The two columns v3 added must NOT leak through: an old build may well
    // parse this row strictly.
    expect(Object.keys(r.rows[0]!)).not.toContain("client_cancellation_enabled");
    expect(Object.keys(r.rows[0]!)).not.toContain("client_reschedule_enabled");
  });

  it("still MOVES the appointment through the wrapper", async () => {
    const f = await seed("v2-works");
    await setFlags(f.studioId, true, true);
    const newStart = at(12, 15, 0);
    expect(await reschedule(f, newStart)).toBe("success");
    const successors = await adminQuery(
      `select count(*)::text as n from public.appointments
        where rescheduled_from_appointment_id = $1`,
      [f.apptId],
    );
    expect(successors.rows[0]!.n, "the wrapper must write the successor").toBe("1");
  });

  it("INHERITS the HON-47 gate: refuses when the flag is off", async () => {
    // It has no gate of its own, so this proves delegation rather than a
    // duplicated check — and it is the case an old build would hit.
    const f = await seed("v2-gate");
    await setFlags(f.studioId, true, false);
    expect(await reschedule(f, at(12, 15, 0))).toBe("reschedule_disabled");
    expect(await status(f.apptId)).toBe("confirmed");
    expect(await startOf(f.apptId)).toBe(new Date(f.startsAt).toISOString());
  });

  it("INHERITS the ordering fix too", async () => {
    // A cancelled appointment at a reschedule-disabled studio must get the
    // generic refusal through the wrapper as well, not the flag refusal.
    const f = await seed("v2-order");
    await setFlags(f.studioId, false, false);
    await adminQuery(
      `update public.appointments set status = 'cancelled' where id = $1`,
      [f.apptId],
    );
    expect(await reschedule(f, at(12, 15, 0))).toBe(
      "appointment_not_reschedulable",
    );
  });
});

// ===========================================================================
// THE PILOT STUDIO'S BEHAVIOUR IS UNCHANGED — Sam's condition on approval.
// ===========================================================================
//
// Sam approved HON-47 as INDEPENDENT per-studio switches, BOTH ENABLED by
// default, on one condition: the live pilot studio's self-service must not
// change. This is that proof.
//
// IT DOES NOT SEED THE PILOT STUDIO, and must not: that is a real tenant with
// real clients (README names it), and no test may touch it. What it seeds is
// the CONFIGURATION — a studio whose `new_client_admission_mode` is each of the
// three legal values, including the waitlisted one the pilot runs, with the two
// HON-47 columns NEVER SET, so they hold the `default true` the migration gives
// them. If self-service still works in every mode at the defaults, then
// applying 0234 changes no existing studio's behaviour, whatever its admission
// mode.
//
// AND IT PROVES THE INDEPENDENCE Sam asked about separately: the flags are not
// derived from, and do not move with, `new_client_admission_mode`. EMERG-01
// reads that mode to refuse rescheduling a free consultation at a waitlisted
// studio; conflating the two would mean disabling client cancellation silently
// changed the pilot's admission behaviour, which is exactly the coupling this
// asserts is absent.
describe("HON-47 changes nothing at the defaults, in ANY admission mode", () => {
  for (const mode of ["open", "waitlist", "closed"] as const) {
    it(`admission mode '${mode}': cancellation still works at the DEFAULTS`, async () => {
      const f = await seed(`default-cancel-${mode}`);
      // The flags are deliberately NOT SET here — only the admission mode is.
      await chooseAdmissionMode(f, mode);
      const flags = await adminQuery(
        `select client_cancellation_enabled as c, client_reschedule_enabled as s
           from public.studios where id = $1`,
        [f.studioId],
      );
      // The precondition, stated: changing the admission mode must not have
      // moved either flag. Without this the case could pass because the mode
      // change happened to leave them true for some other reason.
      expect(flags.rows[0], "the admission mode must not move the flags").toEqual({
        c: true,
        s: true,
      });
      expect(await cancel7(f)).toBe("cancelled");
    });

    it(`admission mode '${mode}': rescheduling still works at the DEFAULTS`, async () => {
      const f = await seed(`default-resched-${mode}`);
      await chooseAdmissionMode(f, mode);
      expect(await reschedule(f, at(12, 15, 0))).toBe("success");
    });
  }

  it("setting a HON-47 flag does not move the admission mode, in either direction", async () => {
    // The other half of independence. A studio's admission authority is
    // owner-controlled through its own command (0204/0205); HON-47 must not
    // touch it, and turning client cancellation off must not quietly waitlist
    // a studio's new-client intake.
    const f = await seed("independence");
    await chooseAdmissionMode(f, "waitlist");
    await setFlags(f.studioId, false, false);
    const after = await adminQuery(
      `select new_client_admission_mode as m,
              client_cancellation_enabled as c,
              client_reschedule_enabled as s
         from public.studios where id = $1`,
      [f.studioId],
    );
    expect(after.rows[0]).toEqual({ m: "waitlist", c: false, s: false });
  });
});

describe("HON-47 does not touch STAFF scheduling", () => {
  it("staff CANCEL still works with BOTH flags false", async () => {
    // practitioner_cancel_appointment is a different command with different
    // grants. A client-facing rule must never reach it, or disabling client
    // cancellation would stop the studio cancelling too.
    const f = await seed("staff-cancel");
    await setFlags(f.studioId, false, false);
    const r = await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4) as result`,
      [f.apptId, f.studioId, f.ownerId, "studio_closed"],
    );
    expect(r.rows[0]!.result).toBe("cancelled");
    expect(await status(f.apptId)).toBe("cancelled");
  });

  it("staff MOVE still works with BOTH flags false", async () => {
    const f = await seed("staff-move");
    await setFlags(f.studioId, false, false);
    const ends = new Date(
      new Date(f.startsAt).getTime() + 45 * 60_000,
    ).toISOString();
    const newStart = at(11, 16, 0);
    const r = await adminQuery(
      `select result from public.move_or_reassign_appointment($1,$2,$3,$4,$5,$6,$7)`,
      [f.apptId, f.studioId, f.ownerId, f.ownerId, f.startsAt, ends, newStart],
    );
    expect(r.rows[0]!.result).toBe("moved");
    expect(await startOf(f.apptId)).toBe(new Date(newStart).toISOString());
  });
});
