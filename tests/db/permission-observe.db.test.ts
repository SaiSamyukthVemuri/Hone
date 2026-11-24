import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OBSERVED_KEY_CONTEXT, observePermissionNow, resetEngineAbsentNotice, type ObserveDb, type ObservedPermission } from "@/lib/permissions/observe-permission";
import { safeLog } from "@/lib/logging/safe-log";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// The observe call against the REAL permission engine (the database function has_studio_permission). It is absent on
// local and CI stacks; without it this file skips and says so, so CI exercises only the engine-absent path (tests/lib/permissions/observe-permission.test.ts).

let present = false;
let studio: SeededStudio;
let assigned: { userId: string; practitionerId: string };
let colleague: { userId: string; practitionerId: string };
let receptionistUser: string;
let appointmentId: string;

const dbFor = (userId: string): ObserveDb => ({
  rpc: (_fn, args) =>
    asUser(userId, (q) =>
      q("select public.has_studio_permission($1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid) as ok", [args.p_studio, args.p_key, args.p_client, args.p_appointment, args.p_practitioner]),
    ).then(
      (r) => ({ data: r.rows[0].ok as unknown, error: null }),
      (e) => ({ data: null, error: e as unknown }),
    ),
});

const ask = async (userId: string, a: ObservedPermission): Promise<boolean | null> => {
  const r = await dbFor(userId).rpc("has_studio_permission", {
    p_studio: studio.studioId,
    p_key: a.key,
    p_client: null,
    p_appointment: a.key === "appt.move" ? a.appointmentId : null,
    p_practitioner: a.key === "appt.book" ? a.practitionerId : null,
  });
  return r.data as boolean | null;
};

const observed = async (userId: string, role: string, a: ObservedPermission): Promise<string[]> => {
  const warn = vi.spyOn(safeLog, "warn").mockImplementation(() => undefined);
  try {
    resetEngineAbsentNotice();
    await observePermissionNow(dbFor(userId), studio.studioId, role, a);
    return warn.mock.calls.map((c) => JSON.parse(String(c[0])).outcome as string);
  } finally {
    warn.mockRestore();
  }
};

beforeAll(async () => {
  const r = await adminQuery(`select count(*)::int as n from pg_proc where proname = 'has_studio_permission' and pronamespace = 'public'::regnamespace`);
  present = r.rows[0].n > 0;
  if (!present) return;
  studio = await seedStudio("observe");
  assigned = await seedMember(studio, "assigned");
  colleague = await seedMember(studio, "colleague");
  receptionistUser = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [receptionistUser, `recep-${receptionistUser.slice(0, 8)}@harness.local`]);
  await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, email) values ($1, $2, 'Desk', $3)`, [studio.studioId, receptionistUser, `recep-${receptionistUser.slice(0, 8)}@harness.local`]);
  appointmentId = randomUUID();
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 1 hour', 60, 0, now() + interval '2 days 1 hour')`,
    [appointmentId, studio.studioId, assigned.practitionerId, studio.clientId],
  );
});
afterAll(closePool);

describe("the observed keys against the installed engine", () => {
  it("pins each key's own-scope context to what the engine says", async (ctx) => {
    if (!present) return ctx.skip();
    const { rows } = await adminQuery(`select key, own_kind from public.permission_catalog where key = any($1::text[])`, [Object.keys(OBSERVED_KEY_CONTEXT)]);
    const live = Object.fromEntries(rows.map((r: { key: string; own_kind: string | null }) => [r.key, r.own_kind]));
    expect(live).toEqual(OBSERVED_KEY_CONTEXT);
  });

  it("answers an unknown key false (why the key set is closed)", async (ctx) => {
    if (!present) return ctx.skip();
    const r = await dbFor(studio.userId).rpc("has_studio_permission", { p_studio: studio.studioId, p_key: "appt.nonexistent", p_client: null, p_appointment: null, p_practitioner: null });
    expect(r.data).toBe(false);
  });

  it("the owner is allowed every observed key, and logs nothing", async (ctx) => {
    if (!present) return ctx.skip();
    for (const a of [
      { key: "appt.book", practitionerId: assigned.practitionerId },
      { key: "appt.move", appointmentId },
      { key: "appt.reassign" },
    ] as ObservedPermission[]) {
      expect(await ask(studio.userId, a), a.key).toBe(true);
      expect(await observed(studio.userId, "owner", a), a.key).toEqual([]);
    }
  });

  it("an assigned practitioner is allowed to book for themself and move their own appointment, with the right context", async (ctx) => {
    if (!present) return ctx.skip();
    expect(await ask(assigned.userId, { key: "appt.book", practitionerId: assigned.practitionerId })).toBe(true);
    expect(await ask(assigned.userId, { key: "appt.move", appointmentId })).toBe(true);
    expect(await observed(assigned.userId, "practitioner", { key: "appt.book", practitionerId: assigned.practitionerId })).toEqual([]);
    expect(await observed(assigned.userId, "practitioner", { key: "appt.move", appointmentId })).toEqual([]);
  });

  it("the wrong context makes the same practitioner look denied (why the call shape is typed)", async (ctx) => {
    if (!present) return ctx.skip();
    const wrong = await dbFor(assigned.userId).rpc("has_studio_permission", { p_studio: studio.studioId, p_key: "appt.book", p_client: null, p_appointment: appointmentId, p_practitioner: null });
    expect(wrong.data).toBe(false);
  });

  it("a colleague is denied another practitioner's booking and appointment, and the denial is logged as would_deny", async (ctx) => {
    if (!present) return ctx.skip();
    expect(await ask(colleague.userId, { key: "appt.book", practitionerId: assigned.practitionerId })).toBe(false);
    expect(await ask(colleague.userId, { key: "appt.move", appointmentId })).toBe(false);
    expect(await observed(colleague.userId, "practitioner", { key: "appt.move", appointmentId })).toEqual(["would_deny"]);
  });

  it("a practitioner is not allowed to reassign by default; the owner is", async (ctx) => {
    if (!present) return ctx.skip();
    expect(await ask(assigned.userId, { key: "appt.reassign" })).toBe(false);
    expect(await ask(studio.userId, { key: "appt.reassign" })).toBe(true);
  });

  it("a receptionist and a stranger are answered, never thrown; a stranger is denied", async (ctx) => {
    if (!present) return ctx.skip();
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `stranger-${stranger.slice(0, 8)}@harness.local`]);
    expect(await ask(stranger, { key: "appt.book", practitionerId: assigned.practitionerId })).toBe(false);
    const recep = await ask(receptionistUser, { key: "appt.book", practitionerId: assigned.practitionerId });
    expect(typeof recep).toBe("boolean");
    expect(await observed(stranger, "none", { key: "appt.reassign" })).toEqual(["would_deny"]);
  });

  it("the cost of one answer, measured on this database (printed, not asserted)", async (ctx) => {
    if (!present) return ctx.skip();
    const rows: string[] = [];
    for (const [label, key, ctxArgs] of [
      ["appt.book", "appt.book", [null, assigned.practitionerId]],
      ["appt.move", "appt.move", [appointmentId, null]],
      ["appt.reassign", "appt.reassign", [null, null]],
    ] as Array<[string, string, [string | null, string | null]]>) {
      const ms = await asUser(assigned.userId, async (q) => {
        const t0 = performance.now();
        await q(
          `select count(*) filter (where public.has_studio_permission($1::uuid, $2::text, null, $3::uuid, $4::uuid)) from generate_series(1, 500)`,
          [studio.studioId, key, ctxArgs[0], ctxArgs[1]],
        );
        return performance.now() - t0;
      });
      rows.push(`${label}: ${(ms / 500).toFixed(3)} ms per call (mean of 500 in one query, authenticated)`);
    }
    console.info(rows.join("\n"));
    expect(rows).toHaveLength(3);
  });
});
