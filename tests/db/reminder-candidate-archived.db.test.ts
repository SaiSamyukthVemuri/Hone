import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { buildReminderCandidateQuery } from "@/lib/cron/reminder-candidate-query";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// MSG-ARCH-01: the reminder cron's candidate query against the REAL stack.
//
// The route filters archived clients IN THE QUERY with an inner embed
// (client:clients!inner(...)) and .is("client.archived_at", null). A wrong
// embedded-filter path would make the selection return nothing, or error, for
// EVERY client, and a fake client cannot show it. This runs the route's exact
// builder (lib/cron/reminder-candidate-query.ts, the module the route calls)
// through real PostgREST over seeded rows. Synthetic data only; assertions
// are scoped by this run's studio ids, never by global counts.
// ===========================================================================

const admin = createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A day far from any other suite's rows, unique per run so reruns coexist.
const DAY = `2031-0${1 + (Math.floor(Math.random() * 8))}-1${Math.floor(Math.random() * 9)}`;
const at = (h: number) => `${DAY}T${String(h).padStart(2, "0")}:00:00.000Z`;
const WINDOW = { startIso: `${DAY}T00:00:00.000Z`, endIso: `${DAY}T23:59:59.000Z` };
const hash64 = () => randomUUID().replaceAll("-", "").padEnd(64, "0");

let A: SeededStudio;
let B: SeededStudio;
let archivedClientId: string;
let appt: { active: string; archived: string; other: string; sent: string };

async function insertAppt(s: SeededStudio, clientId: string, hour: number, sentAt?: string) {
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash, reminder_24h_sent_at)
     values (gen_random_uuid(), $1, $2, $3, null, $4::timestamptz, $5::timestamptz,
             60, 'confirmed', $6, $7::timestamptz)
     returning id`,
    [s.studioId, s.practitionerId, clientId, at(hour), at(hour + 1), hash64(), sentAt ?? null],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  A = await seedStudio("rem-arch-a");
  B = await seedStudio("rem-arch-b");
  archivedClientId = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name, archived_at) values ($1, $2, 'Archived', now())`,
    [archivedClientId, A.studioId],
  );
  appt = {
    active: await insertAppt(A, A.clientId, 10),
    archived: await insertAppt(A, archivedClientId, 12),
    other: await insertAppt(B, B.clientId, 14),
    // Window filter control: already reminded, must stay excluded.
    sent: await insertAppt(A, A.clientId, 16, at(1)),
  };
});

afterAll(async () => {
  await closePool();
});

const ours = (rows: Array<{ id: string }> | null) =>
  (rows ?? []).filter((r) => [appt.active, appt.archived, appt.other, appt.sent].includes(r.id)).map((r) => r.id);

function run(opts: Partial<Parameters<typeof buildReminderCandidateQuery>[1]> = {}) {
  return buildReminderCandidateQuery(admin, {
    ...WINDOW,
    notSentColumn: "reminder_24h_sent_at",
    attemptsColumn: "reminder_24h_send_attempts",
    after: null,
    limit: 50,
    signal: new AbortController().signal,
    ...opts,
  });
}

describe("the route's exact candidate query, on the real chain", () => {
  it("does not error, and returns the non-archived client's appointment", async () => {
    const { data, error } = await run();
    expect(error).toBeNull();
    expect(ours(data)).toContain(appt.active);
  });

  it("excludes the archived client's appointment", async () => {
    const { data, error } = await run();
    expect(error).toBeNull();
    expect(ours(data)).not.toContain(appt.archived);
  });

  it("another studio's non-archived rows behave as before (returned)", async () => {
    const { data } = await run();
    expect(ours(data)).toContain(appt.other);
  });

  it("the window filters still apply (an already-reminded row stays out)", async () => {
    const { data } = await run();
    expect(ours(data)).not.toContain(appt.sent);
    expect(ours(data).sort()).toEqual([appt.active, appt.other].sort());
  });

  it("the embed still carries the columns the passes read, and archived_at is null", async () => {
    const { data } = await run();
    const row = (data ?? []).find((r) => r.id === appt.active) as unknown as { client: Record<string, unknown> };
    const client = Array.isArray(row.client) ? row.client[0] : row.client;
    expect(client).toMatchObject({ archived_at: null });
    for (const col of ["name", "email", "phone", "sms_consent_at", "sms_opted_out_at"]) expect(client).toHaveProperty(col);
  });

  it("the keyset cursor works with the filter (second page after the first row)", async () => {
    const first = await run({ limit: 1 });
    expect(first.error).toBeNull();
    const firstRow = (first.data ?? [])[0] as { id: string; starts_at: string } | undefined;
    expect(firstRow).toBeDefined();
    const next = await run({ after: { startsAt: firstRow!.starts_at, id: firstRow!.id }, limit: 50 });
    expect(next.error).toBeNull();
    expect((next.data ?? []).map((r) => r.id)).not.toContain(firstRow!.id);
  });

  it("the SMS column variant of the same query also runs without error", async () => {
    const { error } = await run({
      notSentColumn: "sms_reminder_24h_sent_at",
      attemptsColumn: "sms_reminder_24h_send_attempts",
    });
    expect(error).toBeNull();
  });

  it("control: without the archived filter the archived row IS selectable (the seed is real)", async () => {
    const { data, error } = await admin
      .from("appointments")
      .select("id, client:clients!inner(archived_at)")
      .eq("studio_id", A.studioId)
      .gte("starts_at", WINDOW.startIso)
      .lte("starts_at", WINDOW.endIso);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(appt.archived);
  });

  it("an unarchived client is selected again (nothing permanent)", async () => {
    await adminQuery(`update public.clients set archived_at = null where id = $1`, [archivedClientId]);
    const { data, error } = await run();
    expect(error).toBeNull();
    expect(ours(data)).toContain(appt.archived);
  });
});
