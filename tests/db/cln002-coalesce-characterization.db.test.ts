// CLN-002 — START_SESSION APPOINTMENT IDENTITY ON THE PRODUCTION CHAIN (0181).
//
// Audit finding CLN-002 (P1/High): "Starting a chart for appointment B can
// return appointment A's session". 0181's coalesce lookup keys on studio,
// client, practitioner, modality and the time window, never on the requested
// appointment, so a B start inside the window of A's chart is handed A's chart.
// The fix is 0241 (#1035), whose hosted apply is held; it is not on this chain.
//
// This file runs on whatever chain the DB lane builds (today 0001 -> 0212) and
// has two parts:
//
//   BASELINE: behaviour that must hold today and after 0241 (create, same-A
//   reuse, no-appointment reuse without relinking, a fresh chart outside the
//   window). Ordinary assertions.
//
//   KNOWN DEFECT (characterization, NOT a gate): the defect, asserted as it is
//   today, so the lane stays green while it proves the defect is real. The
//   "target" case is an `it.fails` expected failure: it states the correct
//   contract and is reported as passing only while that contract is broken.
//   The positive characterization keeps the expected failure honest: a fixture
//   error cannot pass for the defect, because the defect itself is asserted.
//
// WHEN 0241 LANDS, this describe turns red on purpose: the characterization no
// longer holds and the `it.fails` target starts passing (which `it.fails`
// reports as a failure). The change that brings 0241 onto this chain deletes
// the KNOWN DEFECT describe and keeps the baseline.
//
// What is still safe today: #978's fail-closed containment in
// app/(app)/clients/[id]/sessions/new/actions.ts reads the chart back and
// refuses one linked to another appointment before any completion, postcare,
// analytics or redirect. Its unit tests feed the action exactly the reply this
// file gets from the real database ({ session_id: A's chart, reused: true },
// readback appointment_id = A):
//   tests/app/clients/sessions/new-action-appointment-link.test.ts
//     "refuses appointment A without completing B, postcare, analytics or redirect"
//   tests/app/clients/sessions/cln002-action-regression.test.ts
//     "an old command that coalesces B onto A's chart is still refused before any side effect"
//
// Synthetic fixtures on the disposable CI stack only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  adminQuery,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const COALESCE_MINUTES = 90;
const CALL5 = "select * from public.start_session($1,$2,$3,$4,$5)";
const CALL4 = "select * from public.start_session($1,$2,$3,$4)";

type Start = { session_id: string; reused: boolean };

let S: SeededStudio;
let user: Client;

beforeAll(async () => {
  S = await seedStudio("cln002-char");
  user = new Client({ connectionString: resolveLocalDbUrl() });
  await user.connect();
  await user.query("set statement_timeout = '15s'");
  await user.query("set role authenticated");
  await user.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: S.userId, role: "authenticated" }),
  ]);
});

afterAll(async () => {
  await user?.end();
  await closePool();
});

let slot = 0;
/** A confirmed, already-ended appointment for the seeded client and practitioner. */
async function appointment(): Promise<string> {
  const id = randomUUID();
  slot += 2;
  await adminQuery(
    `insert into public.appointments
       (id,studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes,status)
     values ($1,$2,$3,$4,now()-make_interval(hours=>$5+1),now()-make_interval(hours=>$5),60,'confirmed')`,
    [id, S.studioId, S.clientId, S.practitionerId, slot],
  );
  return id;
}

async function start(appointmentId: string | null, call: string = CALL5): Promise<Start> {
  const args: unknown[] = [S.clientId, "electrolysis", appointmentId, COALESCE_MINUTES];
  if (call === CALL5) args.push(S.studioId);
  const r = await user.query(call, args);
  return r.rows[0] as Start;
}

async function links(): Promise<Array<{ id: string; appointment_id: string | null }>> {
  const r = await adminQuery(
    `select id, appointment_id from public.sessions
      where client_id=$1 and deleted_at is null order by started_at, id`,
    [S.clientId],
  );
  return r.rows as Array<{ id: string; appointment_id: string | null }>;
}

async function purge(): Promise<void> {
  await adminQuery(`delete from public.sessions where client_id=$1`, [S.clientId]);
}

describe("CLN-002 baseline: start_session behaviour that holds before and after 0241", () => {
  it("a start for A creates one chart linked to A", async () => {
    await purge();
    const a = await appointment();
    const first = await start(a);
    expect(first.reused).toBe(false);
    expect(await links()).toEqual([{ id: first.session_id, appointment_id: a }]);
  });

  it("a second start for A inside the window reuses A's chart and keeps its link", async () => {
    await purge();
    const a = await appointment();
    const first = await start(a);
    const again = await start(a);
    expect(again).toEqual({ session_id: first.session_id, reused: true });
    expect(await links()).toEqual([{ id: first.session_id, appointment_id: a }]);
  });

  it("a start with no appointment reuses the recent chart without relinking it", async () => {
    await purge();
    const a = await appointment();
    const first = await start(a);
    expect(await start(null)).toEqual({ session_id: first.session_id, reused: true });
    expect(await links()).toEqual([{ id: first.session_id, appointment_id: a }]);
  });

  it("outside the coalesce window a start for B creates B's own chart", async () => {
    await purge();
    const a = await appointment();
    const b = await appointment();
    const first = await start(a);
    await adminQuery(`update public.sessions set started_at = now() - interval '91 minutes' where id=$1`, [first.session_id]);
    const second = await start(b);
    expect(second.reused).toBe(false);
    expect(second.session_id).not.toBe(first.session_id);
    expect(await links()).toEqual([
      { id: first.session_id, appointment_id: a },
      { id: second.session_id, appointment_id: b },
    ]);
  });
});

describe("KNOWN DEFECT CLN-002 (characterization, not a gate; 0241 held in #1035)", () => {
  for (const [label, call] of [["five-argument", CALL5], ["legacy four-argument", CALL4]] as const) {
    it(`today (0181, ${label}): a start for B inside A's window is handed A's chart, still linked to A`, async () => {
      await purge();
      const a = await appointment();
      const b = await appointment();
      const first = await start(a, call);
      const second = await start(b, call);
      // THE DEFECT: B gets A's chart back as a reuse.
      expect(second).toEqual({ session_id: first.session_id, reused: true });
      // A's link is not overwritten, and B has no chart of its own. This is the
      // exact reply #978's readback refuses at the application layer.
      expect(await links()).toEqual([{ id: first.session_id, appointment_id: a }]);
    });
  }

  it.fails("target contract (0241): a start for B inside A's window gets B's own chart", async () => {
    await purge();
    const a = await appointment();
    const b = await appointment();
    const first = await start(a);
    const second = await start(b);
    expect(second.reused).toBe(false);
    expect(second.session_id).not.toBe(first.session_id);
    expect(await links()).toEqual([
      { id: first.session_id, appointment_id: a },
      { id: second.session_id, appointment_id: b },
    ]);
  });
});
