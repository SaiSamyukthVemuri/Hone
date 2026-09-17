import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// WAIT S3 — BEHAVIOURAL PROOF OF 0199's SELECTION CONTRACT.
//
// The migration tests assert SHAPE (privileges, read-only, boundedness). This
// suite asserts BEHAVIOUR: which rows come back, which studios are reported,
// and — the part that matters — that an unsendable row cannot occupy a page
// slot that a sendable row needed.
//
// Every assertion is scoped to ids seeded by the test. The local database is
// shared, so a global count would be someone else's data.

// A PRIVATE WINDOW PER TEST.
//
// reminder_sms_candidates is a GLOBAL read — it takes a time window, not a
// studio — and the local database is shared and accumulates rows across runs.
// A fixed window therefore mixes another run's appointments into the page, and
// the starvation proofs below depend on a small limit being spent on THIS
// test's rows and no others. Each test takes its own far-future day, so the
// only rows in range are the ones it seeded.
const WINDOW_SPAN_HOURS = 36;
let WINDOW_START = "";
let WINDOW_END = "";

function freshWindow() {
  const dayOffset = Number(BigInt("0x" + randomUUID().replace(/-/g, "").slice(0, 12)) % 90000n);
  const start = Date.UTC(2040, 0, 1) + dayOffset * 86400_000;
  WINDOW_START = new Date(start).toISOString();
  WINDOW_END = new Date(start + WINDOW_SPAN_HOURS * 3600_000).toISOString();
}

let S: SeededStudio;

async function setToggles(studioId: string, on: boolean) {
  await adminQuery(
    `update public.studios set send_24h_sms_reminders = $2, send_2h_sms_reminders = $2 where id = $1`,
    [studioId, on],
  );
}

async function activeSender(studio: SeededStudio) {
  // The full ACTIVE shape. studio_sms_senders carries 18 check constraints and
  // an active row must satisfy all of them — claimed number present and equal
  // to the purchased one, claim key in the `hone-sms-<32 hex>` shape with its
  // evidence pair, and the provisioned/tested timestamps set. Seeding anything
  // less would either fail the insert or, worse, leave a row this suite
  // believed was routable when the resolver would refuse it.
  const hex = () => randomUUID().replace(/-/g, "");
  // phone_number is globally unique and the local database accumulates rows
  // across runs, so this must not be a counter.
  const phone =
    "+1" + (BigInt("0x" + hex().slice(0, 15)) % 1000000000n).toString().padStart(9, "0");
  await adminQuery(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country,
        claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
        provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id,
        provisioning_lease_generation, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', 'active', 'CA',
             $2, $2, $3, $4,
             $5, now(), $6,
             1, now(), now())`,
    [studio.studioId, phone, `PN${hex()}`, `MG${hex()}`, `hone-sms-${hex()}`, studio.practitionerId],
  );
}


/** A client whose `phone` is exactly `phone`, consented and not opted out. */
async function seedClient(studioId: string, phone: string | null, opts?: {
  consent?: boolean;
  optedOut?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name, phone, sms_consent_at, sms_opted_out_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      studioId,
      `C ${id.slice(0, 8)}`,
      phone,
      opts?.consent === false ? null : "2031-01-01T00:00:00Z",
      opts?.optedOut ? "2031-02-01T00:00:00Z" : null,
    ],
  );
  return id;
}

/**
 * An appointment inside the window, unsent and under the attempt cap.
 *
 * Slots are allocated in CALL ORDER, two hours apart, 30 minutes long. A
 * studio's appointments may not overlap (appointment_buffer_conflict), and the
 * starvation proofs depend on the unsendable rows sorting BEFORE the sendable
 * one — so position must follow seeding order rather than a time each test
 * picks by hand and has to keep consistent.
 */
let slot = 0;
async function seedAppointment(studioId: string, clientId: string): Promise<string> {
  const id = randomUUID();
  const startsAt = new Date(
    Date.parse(WINDOW_START) + (slot++ * 2 + 1) * 3600_000,
  ).toISOString();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        status, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes',
             30, 'confirmed', 0, $4::timestamptz + interval '30 minutes')`,
    [id, studioId, clientId, startsAt],
  );
  return id;
}

async function candidates(limit = 50): Promise<string[]> {
  const res = await adminQuery(
    `select appointment_id from public.reminder_sms_candidates(
       '24h', $1::timestamptz, $2::timestamptz, null, null, $3, 3)`,
    [WINDOW_START, WINDOW_END, limit],
  );
  return res.rows.map((r: { appointment_id: string }) => r.appointment_id);
}

async function unroutable(): Promise<Array<{ studio_id: string; candidate_count: string }>> {
  const res = await adminQuery(
    `select studio_id, candidate_count from public.reminder_sms_unroutable_studios(
       '24h', $1::timestamptz, $2::timestamptz, 200, 3)`,
    [WINDOW_START, WINDOW_END],
  );
  return res.rows;
}

beforeEach(async () => {
  slot = 0;
  freshWindow();
  S = await seedStudio("sms-select");
  await setToggles(S.studioId, true);
});

afterAll(async () => {
  await closePool();
});

describe("0199 — a client the sender cannot address is not a candidate", () => {
  it("selects a well-formed phone and rejects a non-blank unsendable one", async () => {
    await activeSender(S);
    const good = await seedClient(S.studioId, "(415) 555-0132");
    const bad = await seedClient(S.studioId, "(415) 555");

    const goodAppt = await seedAppointment(S.studioId, good);
    const badAppt = await seedAppointment(S.studioId, bad);

    const ids = await candidates();
    expect(ids).toContain(goodAppt);
    // The P1: `phone is not null and btrim(phone) <> ''` accepted this row.
    expect(ids).not.toContain(badAppt);
  });

  it.each([
    ["null phone", null],
    ["empty phone", ""],
    ["whitespace phone", "   "],
    ["punctuation only", "()- "],
    ["too few digits", "12345"],
    ["plus below the E.164 minimum", "+1234567"],
    ["plus above the E.164 maximum", "+1234567890123456"],
    ["digits with an extension", "4155550132 x22"],
  ])("excludes %s", async (_label, phone) => {
    await activeSender(S);
    const client = await seedClient(S.studioId, phone);
    const appt = await seedAppointment(S.studioId, client);
    expect(await candidates()).not.toContain(appt);
  });

  it("still excludes a sendable phone without consent, or after a STOP", async () => {
    // The phone fact is necessary, not sufficient — it must not be mistaken
    // for a consent decision.
    await activeSender(S);
    const noConsent = await seedClient(S.studioId, "4155550133", { consent: false });
    const optedOut = await seedClient(S.studioId, "4155550134", { optedOut: true });
    const a1 = await seedAppointment(S.studioId, noConsent);
    const a2 = await seedAppointment(S.studioId, optedOut);

    const ids = await candidates();
    expect(ids).not.toContain(a1);
    expect(ids).not.toContain(a2);
  });
});

describe("0199 — unsendable rows cannot starve sendable ones", () => {
  it("returns the sendable appointment that sorts behind a full page of unsendable ones", async () => {
    // THE STARVATION MODEL, end to end. Five unsendable appointments sort
    // BEFORE the sendable one, and the page limit is 2. If unsendable rows
    // occupied slots, the sendable row could never be reached — on this pass
    // or any later one, because a refusal changes no state and the order is
    // stable.
    await activeSender(S);

    const bad = await seedClient(S.studioId, "(415) 555");
    for (let i = 0; i < 5; i++) {
      await seedAppointment(S.studioId, bad);
    }

    const good = await seedClient(S.studioId, "4155550132");
    const goodAppt = await seedAppointment(S.studioId, good);

    const page = await candidates(2);
    expect(page).toContain(goodAppt);
    expect(page.length).toBeLessThanOrEqual(2);
  });

  it("returns exactly p_limit rows when more are sendable", async () => {
    // BOUNDEDNESS, asserted against a page that is actually full. The
    // starvation proofs above happen to leave one sendable row, so they pass
    // against a function that ignores p_limit entirely — a negative control
    // replacing the clamp with a literal `limit 200` left them all green. This
    // is the assertion that bites: six sendable rows, a page of two.
    await activeSender(S);
    const good = await seedClient(S.studioId, "4155550132");
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) seeded.push(await seedAppointment(S.studioId, good));

    const page = await candidates(2);
    expect(page).toHaveLength(2);
    // And it is the FIRST two by (starts_at, id), not an arbitrary two.
    expect(page).toEqual(seeded.slice(0, 2));
  });

  it("clamps an absurd or missing limit instead of returning everything", async () => {
    await activeSender(S);
    const good = await seedClient(S.studioId, "4155550132");
    for (let i = 0; i < 3; i++) await seedAppointment(S.studioId, good);

    const res = await adminQuery(
      `select count(*)::int as n from public.reminder_sms_candidates(
         '24h', $1::timestamptz, $2::timestamptz, null, null, 100000, 3)`,
      [WINDOW_START, WINDOW_END],
    );
    // Bounded by the ceiling, never by what the caller asked for.
    expect(res.rows[0].n).toBeLessThanOrEqual(200);
  });

  it("is stable: the same starved row is returned on a repeated pass", async () => {
    // A fix that depended on ordering luck would not survive repetition.
    await activeSender(S);
    const bad = await seedClient(S.studioId, "abc");
    for (let i = 0; i < 3; i++) {
      await seedAppointment(S.studioId, bad);
    }
    const good = await seedClient(S.studioId, "+441234567890");
    const goodAppt = await seedAppointment(S.studioId, good);

    expect(await candidates(1)).toEqual([goodAppt]);
    expect(await candidates(1)).toEqual([goodAppt]);
  });
});

describe("0199 — the complement reports exactly the studios that want to send and cannot", () => {
  it("reports a studio with a sendable client and no active sender", async () => {
    const client = await seedClient(S.studioId, "4155550132");
    await seedAppointment(S.studioId, client);

    const rows = await unroutable();
    const mine = rows.find((r) => r.studio_id === S.studioId);
    expect(mine).toBeDefined();
    expect(Number(mine!.candidate_count)).toBe(1);
  });

  it("does NOT report a studio whose only appointments are unsendable", async () => {
    // P2 #2. The complement previously applied no client gates at all, so a
    // studio with nothing to send was raised to an operator as a routing
    // fault. An alert that fires with no cause is how operators learn to
    // ignore alerts.
    const bad = await seedClient(S.studioId, "(415) 555");
    const noConsent = await seedClient(S.studioId, "4155550132", { consent: false });
    await seedAppointment(S.studioId, bad);
    await seedAppointment(S.studioId, noConsent);

    expect((await unroutable()).map((r) => r.studio_id)).not.toContain(S.studioId);
  });

  it("counts only the sendable appointments for a reported studio", async () => {
    const good = await seedClient(S.studioId, "4155550132");
    const bad = await seedClient(S.studioId, "(415) 555");
    await seedAppointment(S.studioId, good);
    await seedAppointment(S.studioId, bad);
    await seedAppointment(S.studioId, bad);

    const mine = (await unroutable()).find((r) => r.studio_id === S.studioId);
    expect(Number(mine!.candidate_count)).toBe(1);
  });

  it("agrees with the candidate side: a studio is reported only when giving it a sender would produce candidates", async () => {
    // The drift detector. Whatever either predicate becomes, the complement
    // must stay the exact complement — reported now, selectable once routable.
    const good = await seedClient(S.studioId, "4155550132");
    const appt = await seedAppointment(S.studioId, good);

    expect((await unroutable()).map((r) => r.studio_id)).toContain(S.studioId);
    expect(await candidates()).not.toContain(appt);

    await activeSender(S);

    expect((await unroutable()).map((r) => r.studio_id)).not.toContain(S.studioId);
    expect(await candidates()).toContain(appt);
  });
});

describe("0199 — the open-alert exclusion is scoped to the event this path records", () => {
  async function openAlert(studioId: string, event: string) {
    await adminQuery(
      `insert into public.ops_alerts (severity, event, message, studio_id)
       values ('warning', $2, 'harness', $1)`,
      [studioId, event],
    );
  }

  it("suppresses a studio that already holds an open not-active alert", async () => {
    // The drain: each pass surfaces studios not yet reported, so a bounded
    // result cannot return the same prefix forever.
    const client = await seedClient(S.studioId, "4155550132");
    await seedAppointment(S.studioId, client);
    await openAlert(S.studioId, "sms_sender_not_active_for_studio");

    expect((await unroutable()).map((r) => r.studio_id)).not.toContain(S.studioId);
  });

  it("still reports a studio whose only open alert is a DIFFERENT routing fault", async () => {
    // P2 #1. Excluding the whole routing vocabulary meant an unresolved
    // `sms_sender_ambiguous` — a different fault, with a different fix —
    // suppressed the not-active alert indefinitely.
    const client = await seedClient(S.studioId, "4155550132");
    await seedAppointment(S.studioId, client);
    await openAlert(S.studioId, "sms_sender_ambiguous");

    expect((await unroutable()).map((r) => r.studio_id)).toContain(S.studioId);
  });

  it("re-arms a studio once its alert is resolved", async () => {
    const client = await seedClient(S.studioId, "4155550132");
    await seedAppointment(S.studioId, client);
    await openAlert(S.studioId, "sms_sender_not_active_for_studio");
    expect((await unroutable()).map((r) => r.studio_id)).not.toContain(S.studioId);

    await adminQuery(
      `update public.ops_alerts set resolved_at = now()
        where studio_id = $1 and event = 'sms_sender_not_active_for_studio'`,
      [S.studioId],
    );
    expect((await unroutable()).map((r) => r.studio_id)).toContain(S.studioId);
  });
});

describe("0199 — the studio toggle still gates selection", () => {
  it("selects nothing for a studio with reminders switched off", async () => {
    await activeSender(S);
    await setToggles(S.studioId, false);
    const client = await seedClient(S.studioId, "4155550132");
    const appt = await seedAppointment(S.studioId, client);

    expect(await candidates()).not.toContain(appt);
    expect((await unroutable()).map((r) => r.studio_id)).not.toContain(S.studioId);
  });
});
