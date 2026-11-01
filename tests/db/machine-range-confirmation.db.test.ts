import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asUser,
  closePool,
  routeFor,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// 0267 — a practitioner's confirmation of an out-of-range value is recorded
// with the capture. CI DB lane only; this file has not been run locally.

const PROFILE = "fixture:db-range-confirmation";
const VERSION = 1;

afterAll(async () => {
  await closePool();
});

async function registerMachine(studio: SeededStudio): Promise<string> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      PROFILE, VERSION, "galvanic", 4, null,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
      ]),
    ],
  );
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1,$2,$3,$4,$5) as id`,
      [studio.studioId, PROFILE, VERSION, "Room 1", []],
    );
    return r.rows[0].id as string;
  });
}

/** One saved capture; returns its id. */
async function capture(studio: SeededStudio, value = "999") {
  const { blockId } = await seedSession(studio);
  const machineId = await registerMachine(studio);
  const route = await routeFor(blockId);
  await asUser(studio.userId, async (q) => {
    await q(
      `select public.record_treatment_setup_group($1,$2,$3,null,$4,$5::jsonb,$6::uuid,$7::uuid,$8)`,
      [
        blockId, machineId, "galvanic", [1],
        JSON.stringify([{ field_key: "current", value, observation_source: "practitioner-entered" }]),
        route.sessionId, route.clientId, "local-1",
      ],
    );
  });
  const c = await adminQuery(
    `select id from public.treatment_setup_captures where session_block_id = $1`,
    [blockId],
  );
  return { blockId, captureId: c.rows[0].id as string, route };
}

const confirm = (
  userId: string,
  captureId: string,
  route: { sessionId: string; clientId: string },
  items: unknown[],
) =>
  asUser(userId, async (q) => {
    const r = await q(
      `select public.record_setup_range_confirmations($1,$2::jsonb,$3::uuid,$4::uuid) as n`,
      [captureId, JSON.stringify(items), route.sessionId, route.clientId],
    );
    return r.rows[0].n as number;
  });

const item = (over: Record<string, unknown> = {}) => ({
  field_key: "current",
  value: "999",
  note_code: "outside_published_specification",
  ...over,
});

describe("0267 · range confirmation recorded with the capture", () => {
  it("records the recorder's confirmation, attributed, against the capture", async () => {
    const studio = await seedStudio("rc-ok");
    const { captureId, route, blockId } = await capture(studio);
    expect(await confirm(studio.userId, captureId, route, [item()])).toBe(1);
    const rows = await adminQuery(
      `select confirmed_value::text as v, note_code, session_block_id
         from public.treatment_setup_range_confirmations where capture_id = $1`,
      [captureId],
    );
    expect(rows.rows).toEqual([
      { v: "999", note_code: "outside_published_specification", session_block_id: blockId },
    ]);
  });

  it("refuses a value that is not the recorded one, and an unknown reading", async () => {
    const studio = await seedStudio("rc-value");
    const { captureId, route } = await capture(studio);
    await expect(confirm(studio.userId, captureId, route, [item({ value: "998" })])).rejects.toThrow(/No such reading/);
    await expect(confirm(studio.userId, captureId, route, [item({ field_key: "nope" })])).rejects.toThrow(/No such reading/);
  });

  it("refuses an unknown note code (a hardware limit is a refusal, never a note)", async () => {
    const studio = await seedStudio("rc-code");
    const { captureId, route } = await capture(studio);
    await expect(
      confirm(studio.userId, captureId, route, [item({ note_code: "outside_hardware_limit" })]),
    ).rejects.toThrow();
  });

  it("is append-only: a repeat is refused and a row cannot be updated", async () => {
    const studio = await seedStudio("rc-once");
    const { captureId, route } = await capture(studio);
    await confirm(studio.userId, captureId, route, [item()]);
    await expect(confirm(studio.userId, captureId, route, [item()])).rejects.toThrow(/duplicate|unique/i);
    await expect(
      adminQuery(
        `update public.treatment_setup_range_confirmations set note_code = 'recommended_protocol_only' where capture_id = $1`,
        [captureId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("refuses another practitioner of the same studio, and another studio", async () => {
    const studio = await seedStudio("rc-who");
    const { captureId, route } = await capture(studio);
    const colleague = await seedMember(studio, "rc-colleague");
    await expect(confirm(colleague.userId, captureId, route, [item()])).rejects.toThrow(/Only the practitioner who recorded/);
    const other = await seedStudio("rc-other");
    await expect(confirm(other.userId, captureId, route, [item()])).rejects.toThrow();
  });

  it("refuses a confirmation back-filled after the capture window", async () => {
    const studio = await seedStudio("rc-late");
    const { captureId, route } = await capture(studio);
    // Captures are immutable, so age it the only way a test can.
    await adminQuery(`alter table public.treatment_setup_captures disable trigger treatment_setup_captures_immutable`);
    try {
      await adminQuery(
        `update public.treatment_setup_captures set recorded_at = now() - interval '11 minutes' where id = $1`,
        [captureId],
      );
    } finally {
      await adminQuery(`alter table public.treatment_setup_captures enable trigger treatment_setup_captures_immutable`);
    }
    await expect(confirm(studio.userId, captureId, route, [item()])).rejects.toThrow(/within 10 minutes/);
  });

  it("is invisible to another studio and unwritable through the table", async () => {
    const studio = await seedStudio("rc-rls");
    const { captureId, route } = await capture(studio);
    await confirm(studio.userId, captureId, route, [item()]);
    const other = await seedStudio("rc-rls-other");
    const seen = await asUser(other.userId, async (q) => {
      const r = await q(`select count(*)::int as n from public.treatment_setup_range_confirmations`);
      return r.rows[0].n as number;
    });
    expect(seen).toBe(0);
    await expect(
      asUser(studio.userId, (q) =>
        q(`delete from public.treatment_setup_range_confirmations where capture_id = $1`, [captureId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("0267 · review cases (Insurance K1, K2, K4; K3 accepted)", () => {
  it("K1: stores the READING's value, so the caller's scale cannot differ", async () => {
    const studio = await seedStudio("rc-scale");
    const { captureId, route } = await capture(studio);
    expect(await confirm(studio.userId, captureId, route, [item({ value: "999.000" })])).toBe(1);
    const rows = await adminQuery(
      `select c.confirmed_value::text as v, r.value_numeric::text as stored
         from public.treatment_setup_range_confirmations c
         join public.treatment_setup_readings r on r.capture_id = c.capture_id and r.field_key = c.field_key
        where c.capture_id = $1`,
      [captureId],
    );
    expect(rows.rows).toEqual([{ v: "999", stored: "999" }]);
  });

  it("K1: refuses a non-finite or non-numeric value", async () => {
    const studio = await seedStudio("rc-nan");
    const { captureId, route } = await capture(studio);
    for (const value of ["NaN", "Infinity", "-Infinity", "abc", ""]) {
      await expect(confirm(studio.userId, captureId, route, [item({ value })])).rejects.toThrow();
    }
  });

  it("K2: trims field_key and stage_key as the capture command does, and stores the trimmed keys", async () => {
    const studio = await seedStudio("rc-trim");
    const { captureId, route } = await capture(studio);
    expect(
      await confirm(studio.userId, captureId, route, [item({ field_key: "  current  ", stage_key: "   " })]),
    ).toBe(1);
    const rows = await adminQuery(
      `select field_key, stage_key from public.treatment_setup_range_confirmations where capture_id = $1`,
      [captureId],
    );
    expect(rows.rows).toEqual([{ field_key: "current", stage_key: null }]);
  });

  it("K2: the table refuses an untrimmed key even for a privileged writer", async () => {
    const studio = await seedStudio("rc-trimck");
    const { captureId, blockId } = await capture(studio);
    await expect(
      adminQuery(
        `insert into public.treatment_setup_range_confirmations
           (studio_id, capture_id, session_block_id, field_key, confirmed_value, note_code, confirmed_by_practitioner_id)
         values ($1,$2,$3,' current',999,'outside_published_specification',$4)`,
        [studio.studioId, captureId, blockId, studio.practitionerId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it("K4: a wrong session or client for the same studio is refused (the cross-client case)", async () => {
    const studio = await seedStudio("rc-route");
    const { captureId, route } = await capture(studio);
    const other = await seedSession(studio);
    const otherRoute = await routeFor(other.blockId);
    await expect(
      confirm(studio.userId, captureId, { sessionId: otherRoute.sessionId, clientId: route.clientId }, [item()]),
    ).rejects.toThrow(/Unknown treatment block/);
    await expect(
      confirm(studio.userId, captureId, { sessionId: route.sessionId, clientId: "00000000-0000-4000-8000-000000000001" }, [item()]),
    ).rejects.toThrow(/Unknown treatment block/);
  });

  it("K4: the item-count limit and malformed items are refused, writing nothing", async () => {
    const studio = await seedStudio("rc-shape");
    const { captureId, route } = await capture(studio);
    const many = Array.from({ length: 201 }, () => item());
    await expect(confirm(studio.userId, captureId, route, many)).rejects.toThrow(/between 1 and 200/);
    await expect(confirm(studio.userId, captureId, route, [])).rejects.toThrow(/between 1 and 200/);
    for (const bad of [null, 7, "x", [], {}, { field_key: "current" }, item({ value: 999 }), item({ note_code: null }), item({ stage_key: 5 })]) {
      await expect(confirm(studio.userId, captureId, route, [bad])).rejects.toThrow(/Each confirmation needs/);
    }
    await expect(
      asUser(studio.userId, async (q) =>
        q(`select public.record_setup_range_confirmations($1,$2::jsonb,$3::uuid,$4::uuid)`, [
          captureId, JSON.stringify({ a: 1 }), route.sessionId, route.clientId,
        ]),
      ),
    ).rejects.toThrow(/between 1 and 200/);
    const n = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_range_confirmations where capture_id = $1`,
      [captureId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("K4: one bad item rolls the whole call back", async () => {
    const studio = await seedStudio("rc-atomic");
    const { captureId, route } = await capture(studio);
    await expect(
      confirm(studio.userId, captureId, route, [item(), item({ field_key: "nope" })]),
    ).rejects.toThrow(/No such reading/);
    const n = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_range_confirmations where capture_id = $1`,
      [captureId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("K4 / K3: a machine retired within the window makes the confirmation final-refused", async () => {
    const studio = await seedStudio("rc-retired");
    const { captureId, route } = await capture(studio);
    await adminQuery(
      `update public.studio_machines set retired_at = now()
        where id = (select studio_machine_id from public.treatment_setup_captures where id = $1)`,
      [captureId],
    );
    await expect(confirm(studio.userId, captureId, route, [item()])).rejects.toThrow();
    const n = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_range_confirmations where capture_id = $1`,
      [captureId],
    );
    expect(n.rows[0].n).toBe(0);
  });
});

describe("0267 function grants (Privacy C1)", () => {
  it("no API role holds EXECUTE on the trigger function; the command is authenticated-only", async () => {
    const rows = await adminQuery(
      `select r.rolname as role,
              has_function_privilege(r.oid, 'public.refuse_range_confirmation_update()', 'execute') as trig,
              has_function_privilege(r.oid, 'public.record_setup_range_confirmations(uuid,jsonb,uuid,uuid)', 'execute') as cmd
         from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by 1`,
    );
    const by = Object.fromEntries(rows.rows.map((r: { role: string; trig: boolean; cmd: boolean }) => [r.role, r]));
    for (const role of ["anon", "authenticated", "service_role"]) expect(by[role].trig).toBe(false);
    expect(by.anon.cmd).toBe(false);
    expect(by.service_role.cmd).toBe(false);
    expect(by.authenticated.cmd).toBe(true);
    const pub = await adminQuery(
      `select p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('refuse_range_confirmation_update','record_setup_range_confirmations')`,
    );
    for (const r of pub.rows) expect(r.acl).not.toMatch(/(^\{|,)=X/);
  });
});
