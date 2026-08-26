import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0186 — the ~24h / ~2h window email, on the REAL migrated database
// ===========================================================================
//
// The source contract (tests/app/api/cron/reminder-window-composition.test.ts)
// proves the route SAYS the six-case law and says it in the right order. It
// cannot prove a race. This file proves the properties that would actually
// hurt if they were wrong, by executing the same RPCs the cron executes:
//
//   1. ONE CLAIM OWNS THE WINDOW. Whatever the pass composes - a plain
//      reminder, a reminder carrying an intake CTA, or a standalone intake
//      reminder - it claims the SAME reminder_24h / reminder_2h slot. So the
//      standalone fallback structurally cannot race the ordinary reminder.
//   2. AT MOST ONE SUCCESSFUL EMAIL PER APPOINTMENT PER WINDOW, including
//      across a toggle flip mid-window and across retries.
//   3. RETRY / EXHAUSTION SEMANTICS ARE UNCHANGED by the new composition.
//   4. THE 7d/3d STATE IS PRESERVED, not reinterpreted: its columns and its
//      claim branches still exist and still behave exactly as 0098 left them.
//   5. THE NEW SETTING defaults TRUE, so applying 0186 changes no studio's
//      behaviour on its own.
//
// THE DECISION IS EXECUTED, NOT ASSUMED. `decide()` below mirrors the route's
// predicate (wantsReminder / intakeEnabled / intakeIncomplete) but reads REAL
// rows, so each of the six cases is driven from real studio settings and real
// intake status rather than from a fixture the test invented.
//
// Every assertion is scoped by ids seeded here, never by global counts, so the
// suite is safe to re-run against a database other worktrees are sharing.

let s: SeededStudio;

const WINDOWS = ["reminder_24h", "reminder_2h"] as const;
type Window = (typeof WINDOWS)[number];

const toggleFor: Record<Window, string> = {
  reminder_24h: "send_24h_reminders",
  reminder_2h: "send_2h_reminders",
};

beforeAll(async () => {
  s = await seedStudio("intake-window");
});

afterAll(async () => {
  await closePool();
});

// Each seeded appointment gets its OWN future slot: the studio-wide overlap
// exclusion constraint is real and would otherwise reject the second insert.
let slot = 0;
async function seedAppointment(): Promise<string> {
  const hoursOut = 24 + slot++ * 2;
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash,
        buffer_minutes_snapshot, blocked_ends_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4::text || ' hours')::interval,
             now() + ($4::text || ' hours')::interval + interval '45 minutes',
             45, 'confirmed', encode(gen_random_bytes(32), 'hex'),
             15,
             now() + ($4::text || ' hours')::interval + interval '60 minutes')
     returning id`,
    [s.studioId, s.practitionerId, s.clientId, String(hoursOut)],
  );
  return r.rows[0].id as string;
}

async function setToggles(win: Window, reminder: boolean, intake: boolean) {
  await adminQuery(
    `update public.studios set ${toggleFor[win]} = $2, send_intake_reminders = $3 where id = $1`,
    [s.studioId, reminder, intake],
  );
}

/** Latest non-deleted intake, or null. Mirrors readLatestIntake in the route. */
async function seedIntake(status: string | null): Promise<string | null> {
  await adminQuery(`delete from public.client_intake_forms where client_id = $1`, [
    s.clientId,
  ]);
  if (status === null) return null;
  const r = await adminQuery(
    `insert into public.client_intake_forms (id, studio_id, client_id, status)
     values (gen_random_uuid(), $1, $2, $3) returning id`,
    [s.studioId, s.clientId, status],
  );
  return r.rows[0].id as string;
}

async function claim(apptId: string, win: Window): Promise<boolean> {
  const r = await adminQuery(
    `select public.claim_email_send($1::uuid, $2::text) as ok`,
    [apptId, win],
  );
  return r.rows[0].ok === true;
}

async function record(apptId: string, win: Window, success: boolean) {
  await adminQuery(
    `select public.record_email_result($1::uuid, $2::text, $3::boolean)`,
    [apptId, win, success],
  );
}

async function sendState(apptId: string, win: Window) {
  const r = await adminQuery(
    `select ${win}_sent_at as sent_at,
            ${win}_send_attempts as attempts,
            ${win}_claimed_at as claimed_at
       from public.appointments where id = $1`,
    [apptId],
  );
  return r.rows[0] as {
    sent_at: Date | null;
    attempts: number;
    claimed_at: Date | null;
  };
}

type Outcome =
  | "reminder_with_intake"
  | "reminder_only"
  | "intake_only"
  | "nothing";

/**
 * The route's decision, executed against real rows. Returns what the pass
 * WOULD compose, and whether it claims at all. Deliberately reads the studio
 * and the intake fresh, in the order the route reads them.
 */
async function decide(
  apptId: string,
  win: Window,
): Promise<{ outcome: Outcome; claims: boolean }> {
  const st = await adminQuery(
    `select ${toggleFor[win]} as reminder_on, send_intake_reminders as intake_on
       from public.studios where id = $1`,
    [s.studioId],
  );
  const wantsReminder = st.rows[0].reminder_on === true;
  const intakeEnabled = st.rows[0].intake_on !== false;

  if (!wantsReminder && !intakeEnabled) return { outcome: "nothing", claims: false };

  const intakeRow = await adminQuery(
    `select id, status from public.client_intake_forms
      where studio_id = $1 and client_id = $2 and deleted_at is null
      order by created_at desc limit 1`,
    [s.studioId, s.clientId],
  );
  const incomplete =
    intakeEnabled && intakeRow.rows[0]?.status === "in_progress";

  // Cases 4/5: whether to claim at all depends on intake state.
  if (!wantsReminder && !incomplete) return { outcome: "nothing", claims: false };

  if (wantsReminder) {
    return {
      outcome: incomplete ? "reminder_with_intake" : "reminder_only",
      claims: true,
    };
  }
  return { outcome: "intake_only", claims: true };
}

// ---------------------------------------------------------------------------
// 5. The new setting
// ---------------------------------------------------------------------------
describe("0186 — studios.send_intake_reminders", () => {
  it("exists and defaults TRUE, so applying the migration changes nothing on its own", async () => {
    const col = await adminQuery(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name = 'send_intake_reminders'`,
    );
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0].data_type).toBe("boolean");
    expect(col.rows[0].is_nullable).toBe("NO");
    expect(String(col.rows[0].column_default)).toMatch(/true/);

    const seeded = await adminQuery(
      `select send_intake_reminders from public.studios where id = $1`,
      [s.studioId],
    );
    expect(seeded.rows[0].send_intake_reminders).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The six cases, each driven from real settings + real intake state
// ---------------------------------------------------------------------------
describe.each(WINDOWS)("%s — the six-case law", (win) => {
  const cases: Array<{
    n: number;
    reminder: boolean;
    intake: boolean;
    status: string | null;
    outcome: Outcome;
    claims: boolean;
  }> = [
    { n: 1, reminder: true, intake: true, status: "in_progress", outcome: "reminder_with_intake", claims: true },
    { n: 2, reminder: true, intake: true, status: "submitted", outcome: "reminder_only", claims: true },
    { n: 3, reminder: true, intake: false, status: "in_progress", outcome: "reminder_only", claims: true },
    { n: 4, reminder: false, intake: true, status: "in_progress", outcome: "intake_only", claims: true },
    { n: 5, reminder: false, intake: true, status: "submitted", outcome: "nothing", claims: false },
    { n: 6, reminder: false, intake: false, status: "in_progress", outcome: "nothing", claims: false },
  ];

  for (const c of cases) {
    it(`CASE ${c.n}: reminder=${c.reminder} intake=${c.intake} status=${c.status} -> ${c.outcome}`, async () => {
      const apptId = await seedAppointment();
      await setToggles(win, c.reminder, c.intake);
      await seedIntake(c.status);

      const d = await decide(apptId, win);
      expect(d.outcome).toBe(c.outcome);
      expect(d.claims).toBe(c.claims);

      if (!d.claims) {
        // CASES 5 and 6: no claim at all, so no attempt is ever counted.
        const before = await sendState(apptId, win);
        expect(before.attempts).toBe(0);
        expect(before.sent_at).toBeNull();
        return;
      }

      expect(await claim(apptId, win)).toBe(true);
      await record(apptId, win, true);
      const after = await sendState(apptId, win);
      expect(after.attempts).toBe(1);
      expect(after.sent_at).not.toBeNull();
      expect(after.claimed_at).toBeNull();
    });
  }

  it("CASE 5 also holds when NO intake row exists at all", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, false, true);
    await seedIntake(null);
    const d = await decide(apptId, win);
    expect(d).toEqual({ outcome: "nothing", claims: false });
    expect((await sendState(apptId, win)).attempts).toBe(0);
  });

  it("a reviewed intake suppresses the CTA exactly like a submitted one", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, true, true);
    await seedIntake("reviewed");
    expect((await decide(apptId, win)).outcome).toBe("reminder_only");
  });
});

// ---------------------------------------------------------------------------
// 1 + 2. Coalescing: one claim owns the window
// ---------------------------------------------------------------------------
describe.each(WINDOWS)("%s — at most one email per appointment per window", (win) => {
  it("two concurrent runs: exactly ONE wins the claim", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, true, true);
    await seedIntake("in_progress");

    const [a, b] = await Promise.all([claim(apptId, win), claim(apptId, win)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The loser did not silently bump a second attempt.
    expect((await sendState(apptId, win)).attempts).toBe(1);
  });

  it("THE SINGLE-SLOT PROOF: a standalone-intake run and a reminder run contend for the SAME slot", async () => {
    // Run A evaluates CASE 4 (reminder off). Between the two runs the studio
    // enables the reminder, so run B evaluates CASE 1. With two independent
    // slots each would win its own and the client would get two emails. They
    // share one slot, so exactly one send happens.
    const apptId = await seedAppointment();
    await setToggles(win, false, true);
    await seedIntake("in_progress");
    const runA = await decide(apptId, win);
    expect(runA.outcome).toBe("intake_only");

    const wonA = await claim(apptId, win);

    await setToggles(win, true, true);
    const runB = await decide(apptId, win);
    expect(runB.outcome).toBe("reminder_with_intake");
    const wonB = await claim(apptId, win);

    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
  });

  it("a standalone intake send consumes the window: enabling the reminder later sends nothing more", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, false, true);
    await seedIntake("in_progress");
    expect(await claim(apptId, win)).toBe(true);
    await record(apptId, win, true); // CASE 4 sent

    await setToggles(win, true, true); // studio turns the reminder back on
    expect(await claim(apptId, win)).toBe(false);
    const st = await sendState(apptId, win);
    expect(st.attempts).toBe(1);
  });

  it("a CASE 4 -> 5 flip after the claim clears the claim and stamps nothing", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, false, true);
    await seedIntake("in_progress");
    expect(await claim(apptId, win)).toBe(true);

    // The client submits between the pre-claim probe and the live re-read.
    await seedIntake("submitted");
    await record(apptId, win, false);

    const st = await sendState(apptId, win);
    expect(st.sent_at).toBeNull();
    expect(st.claimed_at).toBeNull(); // claim released promptly, not left stale
    expect(st.attempts).toBe(1); // the attempt the claim counted stands

    // Every later fire exits at the pre-claim probe, so nothing else is spent.
    expect((await decide(apptId, win)).claims).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Retry / exhaustion
// ---------------------------------------------------------------------------
describe.each(WINDOWS)("%s — retry and exhaustion", (win) => {
  it("a failed send leaves the row retryable and never stamps sent_at", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, true, true);
    await seedIntake("in_progress");

    expect(await claim(apptId, win)).toBe(true);
    await record(apptId, win, false);
    let st = await sendState(apptId, win);
    expect(st.sent_at).toBeNull();
    expect(st.attempts).toBe(1);

    expect(await claim(apptId, win)).toBe(true);
    await record(apptId, win, true);
    st = await sendState(apptId, win);
    expect(st.sent_at).not.toBeNull();
    expect(st.attempts).toBe(2);
  });

  it("gives up after 3 attempts and never sends a 4th", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, true, true);
    await seedIntake("in_progress");

    for (let i = 0; i < 3; i++) {
      expect(await claim(apptId, win)).toBe(true);
      await record(apptId, win, false);
    }
    expect(await claim(apptId, win)).toBe(false);
    const st = await sendState(apptId, win);
    expect(st.attempts).toBe(3);
    expect(st.sent_at).toBeNull();
  });

  it("retries preserve at-most-one SUCCESS: a second claim after success is refused", async () => {
    const apptId = await seedAppointment();
    await setToggles(win, true, true);
    await seedIntake("in_progress");
    expect(await claim(apptId, win)).toBe(true);
    await record(apptId, win, true);
    expect(await claim(apptId, win)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The retired cadence is preserved, not reinterpreted
// ---------------------------------------------------------------------------
describe("the 7d/3d intake state survives 0186 untouched", () => {
  it("keeps every 0098 column", async () => {
    const r = await adminQuery(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments'
          and column_name like 'intake_reminder_%'
        order by column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      "intake_reminder_3d_claimed_at",
      "intake_reminder_3d_send_attempts",
      "intake_reminder_3d_sent_at",
      "intake_reminder_7d_claimed_at",
      "intake_reminder_7d_send_attempts",
      "intake_reminder_7d_sent_at",
    ]);
  });

  it("keeps both 0098 claim branches working, on their OWN columns", async () => {
    const apptId = await seedAppointment();
    const r = await adminQuery(
      `select public.claim_email_send($1::uuid, 'intake_reminder_7d') as ok`,
      [apptId],
    );
    expect(r.rows[0].ok).toBe(true);

    const st = await adminQuery(
      `select intake_reminder_7d_send_attempts as legacy_attempts,
              reminder_24h_send_attempts as window_attempts
         from public.appointments where id = $1`,
      [apptId],
    );
    // A legacy claim moves ONLY the legacy counter. The two are independent,
    // which is exactly why the new cadence needed its own state rather than a
    // reinterpretation of these columns.
    expect(st.rows[0].legacy_attempts).toBe(1);
    expect(st.rows[0].window_attempts).toBe(0);
  });

  it("a 7d stamp never suppresses the new window email", async () => {
    const apptId = await seedAppointment();
    await adminQuery(
      `update public.appointments set intake_reminder_7d_sent_at = now() where id = $1`,
      [apptId],
    );
    await setToggles("reminder_24h", true, true);
    await seedIntake("in_progress");
    expect(await claim(apptId, "reminder_24h")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SMS: the same one-message-per-window guarantee, on the existing SMS slot
// ---------------------------------------------------------------------------
async function claimSms(apptId: string, win: Window): Promise<boolean> {
  const r = await adminQuery(
    `select public.claim_sms_send($1::uuid, $2::text) as ok`,
    [apptId, win],
  );
  return r.rows[0].ok === true;
}

async function recordSms(apptId: string, win: Window, success: boolean) {
  await adminQuery(
    `select public.record_sms_result($1::uuid, $2::text, $3::boolean)`,
    [apptId, win, success],
  );
}

async function smsState(apptId: string, win: Window) {
  const r = await adminQuery(
    `select sms_${win}_sent_at as sent_at,
            sms_${win}_send_attempts as attempts
       from public.appointments where id = $1`,
    [apptId],
  );
  return r.rows[0] as { sent_at: Date | null; attempts: number };
}

describe.each(WINDOWS)("%s — at most ONE SMS per appointment per window", (win) => {
  it("two concurrent runs: exactly one SMS claim wins", async () => {
    const apptId = await seedAppointment();
    const [a, b] = await Promise.all([claimSms(apptId, win), claimSms(apptId, win)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await smsState(apptId, win)).attempts).toBe(1);
  });

  it("a retry after failure does not duplicate the message", async () => {
    const apptId = await seedAppointment();
    expect(await claimSms(apptId, win)).toBe(true);
    await recordSms(apptId, win, false);
    expect((await smsState(apptId, win)).sent_at).toBeNull();

    expect(await claimSms(apptId, win)).toBe(true);
    await recordSms(apptId, win, true);
    const st = await smsState(apptId, win);
    expect(st.sent_at).not.toBeNull();
    expect(st.attempts).toBe(2);

    // Once sent, the window is closed for SMS too.
    expect(await claimSms(apptId, win)).toBe(false);
  });

  it("gives up after 3 SMS attempts", async () => {
    const apptId = await seedAppointment();
    for (let i = 0; i < 3; i++) {
      expect(await claimSms(apptId, win)).toBe(true);
      await recordSms(apptId, win, false);
    }
    expect(await claimSms(apptId, win)).toBe(false);
    expect((await smsState(apptId, win)).sent_at).toBeNull();
  });

  it("the SMS slot is INDEPENDENT of the email slot: one email AND one SMS is allowed", async () => {
    const apptId = await seedAppointment();
    expect(await claim(apptId, win)).toBe(true); // email window
    await record(apptId, win, true);
    expect(await claimSms(apptId, win)).toBe(true); // SMS window, unaffected
    await recordSms(apptId, win, true);

    const email = await sendState(apptId, win);
    const sms = await smsState(apptId, win);
    expect(email.sent_at).not.toBeNull();
    expect(sms.sent_at).not.toBeNull();
    // Neither channel counted the other's attempt.
    expect(email.attempts).toBe(1);
    expect(sms.attempts).toBe(1);
  });

  it("the composition needs no new SMS state: 0186 added nothing to appointments", async () => {
    const r = await adminQuery(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments'
          and column_name like '%intake%' and column_name not like 'intake_reminder_%'`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe("SMS intake CTA follows the SAME definition of incomplete", () => {
  // "Incomplete" is exactly: the LATEST non-deleted intake row for this
  // studio+client has status 'in_progress'. Submitted or reviewed means no
  // intake CTA in the appointment SMS and no intake SMS at all.
  it.each(["submitted", "reviewed"])(
    "a %s latest intake yields no CTA",
    async (status) => {
      const apptId = await seedAppointment();
      await setToggles("reminder_24h", true, true);
      await seedIntake(status);
      expect((await decide(apptId, "reminder_24h")).outcome).toBe("reminder_only");
    },
  );

  it("a SOFT-DELETED in_progress row does not count as incomplete", async () => {
    const apptId = await seedAppointment();
    await setToggles("reminder_24h", true, true);
    await seedIntake("in_progress");
    await adminQuery(
      `update public.client_intake_forms set deleted_at = now() where client_id = $1`,
      [s.clientId],
    );
    expect((await decide(apptId, "reminder_24h")).outcome).toBe("reminder_only");
  });

  it("the LATEST row wins: a newer submitted row overrides an older in_progress one", async () => {
    const apptId = await seedAppointment();
    await setToggles("reminder_24h", true, true);
    await seedIntake("in_progress");
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, created_at)
       values (gen_random_uuid(), $1, $2, 'submitted', now() + interval '1 second')`,
      [s.studioId, s.clientId],
    );
    expect((await decide(apptId, "reminder_24h")).outcome).toBe("reminder_only");
  });
});

describe("the SMS consent model is untouched by the intake composition", () => {
  it("still keys off the client's phone, consent and opt-out columns", async () => {
    const r = await adminQuery(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'clients'
          and column_name in ('phone', 'sms_consent_at', 'sms_opted_out_at')
        order by column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      "phone",
      "sms_consent_at",
      "sms_opted_out_at",
    ]);
  });

  it("still keys off the per-window studio SMS toggles, which 0186 did not change", async () => {
    const r = await adminQuery(
      `select send_24h_sms_reminders, send_2h_sms_reminders, send_intake_reminders
         from public.studios where id = $1`,
      [s.studioId],
    );
    // The SMS toggles keep their own default (false, 0049); the new master
    // intake toggle defaults true and cannot enable SMS on its own.
    expect(r.rows[0].send_24h_sms_reminders).toBe(false);
    expect(r.rows[0].send_2h_sms_reminders).toBe(false);
    expect(r.rows[0].send_intake_reminders).toBe(true);
  });
});
