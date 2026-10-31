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
