// CLN-002 — START_SESSION APPOINTMENT IDENTITY, SCHEMA-AWARE.
//
// Audit finding CLN-002 (P1/High): "Starting a chart for appointment B can
// return appointment A's session". 0181's coalesce lookup keys on studio,
// client, practitioner, modality and the time window, never on the requested
// appointment, so a B start inside the window of A's chart is handed A's chart.
// The fix is 0241 (#1035), whose hosted apply is held.
//
// This file asks the DATABASE which start_session it runs (the function's own
// source, cross-checked against the recorded migrations; see
// helpers/start-session-shape.ts, pinned on both shapes without a database by
// tests/migrations/cln002-start-session-shape.test.ts), and asserts the
// contract that chain is meant to have. The same tests run on both chains;
// nothing is skipped and nothing needs editing when 0241 lands.
//
//   BASELINE: behaviour that holds on both chains (create, same-A reuse,
//   no-appointment reuse without relinking, a fresh chart outside the window).
//
//   SHAPE: the detector must resolve to exactly one shape. If the two signals
//   disagree, or the source is neither shape, the file FAILS rather than guess.
//
//   CLN-002 CONTRACT, by shape:
//     0181 (the production chain): the KNOWN DEFECT is asserted as it is, so the
//       lane stays green while proving the defect is real: a B start inside A's
//       window is handed A's chart, still linked to A, with no B chart; and the
//       target contract, checked directly, does NOT hold. That second assertion
//       is explicit (the check must throw), so a fixture error cannot pass for
//       the defect.
//     0241: the TARGET contract holds: B gets its own chart, A's stays linked to
//       A; and the defect reply is absent.
//   Both the five-argument and the legacy four-argument calls are covered
//   (0241 keeps 0181's four-argument wrapper, which delegates).
//
// What is still safe on the 0181 chain: #978's fail-closed containment in
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
import { resolveStartSessionShape, type StartSessionShape } from "./helpers/start-session-shape";

const COALESCE_MINUTES = 90;
const CALL5 = "select * from public.start_session($1,$2,$3,$4,$5)";
const CALL4 = "select * from public.start_session($1,$2,$3,$4)";

type Start = { session_id: string; reused: boolean };

let S: SeededStudio;
let user: Client;
let shape: StartSessionShape;

/** The start_session this database runs, from its own source and history. */
async function detectShape(): Promise<StartSessionShape> {
  const src = await adminQuery(
    `select p.prosrc from pg_proc p
      where p.oid = 'public.start_session(uuid,text,uuid,integer,uuid)'::regprocedure`,
  );
  if (src.rows.length !== 1) throw new Error(`expected one five-argument start_session, found ${src.rows.length}`);
  const hist = await adminQuery(`select version from supabase_migrations.schema_migrations order by version`);
  return resolveStartSessionShape({
    prosrc: (src.rows[0] as { prosrc: string }).prosrc,
    migrationsRecorded: (hist.rows as Array<{ version: string }>).map((r) => r.version),
  });
}

beforeAll(async () => {
  shape = await detectShape();
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

describe("CLN-002 start_session shape", () => {
  it("resolves to exactly one shape from the database (never guessed)", () => {
    expect(["0181", "0241"]).toContain(shape);
  });
});

describe("CLN-002 contract for the start_session this database runs", () => {
  for (const [label, call] of [["five-argument", CALL5], ["legacy four-argument", CALL4]] as const) {
    /** The target contract (0241): B inside A's window gets B's own chart. */
    async function targetContract(): Promise<void> {
      await purge();
      const a = await appointment();
      const b = await appointment();
      const first = await start(a, call);
      const second = await start(b, call);
      expect(second.reused).toBe(false);
      expect(second.session_id).not.toBe(first.session_id);
      expect(await links()).toEqual([
        { id: first.session_id, appointment_id: a },
        { id: second.session_id, appointment_id: b },
      ]);
    }

    it(`${label}: a start for B inside A's window follows the contract of the detected shape`, async () => {
      if (shape === "0241") {
        await targetContract();
        return;
      }
      // 0181: THE KNOWN DEFECT, asserted as it is today.
      await purge();
      const a = await appointment();
      const b = await appointment();
      const first = await start(a, call);
      const second = await start(b, call);
      // B gets A's chart back as a reuse.
      expect(second).toEqual({ session_id: first.session_id, reused: true });
      // A's link is not overwritten, and B has no chart of its own. This is the
      // exact reply #978's readback refuses at the application layer.
      expect(await links()).toEqual([{ id: first.session_id, appointment_id: a }]);
      // And the target contract, checked directly, does not hold here. It must
      // throw; if it passes, the detector and the database disagree.
      await expect(targetContract()).rejects.toThrow();
    });
  }

  it("a start for B inside the window never takes a chart linked to a different appointment (both chains)", async () => {
    await purge();
    const a = await appointment();
    const b = await appointment();
    const first = await start(a);
    const second = await start(b);
    // On 0181 B is handed A's chart, which stays linked to A. On 0241 B has its
    // own. Either way A's link is never overwritten to B.
    expect((await links()).find((l) => l.id === first.session_id)?.appointment_id).toBe(a);
    expect(second.session_id === first.session_id).toBe(shape === "0181");
  });
});
