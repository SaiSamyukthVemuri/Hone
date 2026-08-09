import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs module without types
import { deriveSyntheticId, isSyntheticId, isVersion8Uuid, ORDINAL_CEILING, partitionIds, syntheticIdSet } from "../../../scripts/synthetic-mirror/identity.mjs";
// @ts-expect-error — .mjs module without types
import { buildPlan, isNoOpPlan, totalAppointments } from "../../../scripts/synthetic-mirror/plan.mjs";
// @ts-expect-error — .mjs module without types
import { buildAppointmentRows, buildClientRows, selectResettableIds } from "../../../scripts/synthetic-mirror/writer.mjs";

const STUDIO = "9d37c51a-0000-4000-8000-000000000002";
const OTHER = "38cb3a8b-0000-4000-8000-000000000001";

// Willow's real aggregate shape at the time of writing, used as a realistic
// fixture. These are COUNTS — the only thing the source ever contributes.
const SOURCE = {
  clients_total: 50,
  clients_with_upcoming: 31,
  appt_confirmed: 68,
  appt_completed: 38,
  appt_cancelled: 22,
  appt_no_show: 2,
  intake_in_progress: 19,
  intake_submitted: 9,
  intake_reviewed: 22,
  sessions_total: 62,
  sessions_missing_aftercare: 26,
  sessions_with_next_note: 31,
};

const EMPTY_TARGET = {
  syntheticClients: 0,
  syntheticAppointments: 0,
  syntheticSessions: 0,
  syntheticIntakes: 0,
};

describe("synthetic identity — provable, deterministic, collision-free", () => {
  it("derives the same id for the same (studio, entity, ordinal), always", () => {
    expect(deriveSyntheticId(STUDIO, "client", 7)).toBe(deriveSyntheticId(STUDIO, "client", 7));
  });

  it("mints RFC 9562 version 8 uuids, which gen_random_uuid() (v4) can never produce", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isVersion8Uuid(deriveSyntheticId(STUDIO, "client", i))).toBe(true);
    }
    // A representative real Hone id is v4 and must never classify as synthetic.
    expect(isVersion8Uuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(false);
  });

  it("never collides across ordinals, entities or studios", () => {
    const ids = new Set<string>();
    for (const studio of [STUDIO, OTHER]) {
      for (const entity of ["client", "appointment", "session", "intake"]) {
        for (let i = 0; i < 300; i += 1) ids.add(deriveSyntheticId(studio, entity, i));
      }
    }
    expect(ids.size).toBe(2 * 4 * 300);
  });

  it("classifies a real v4 id as NOT synthetic — reset must refuse it", () => {
    expect(isSyntheticId("3f2504e0-4f89-41d3-9a0c-0305e82c3301", STUDIO, "client", 500)).toBe(false);
  });

  it("classifies another studio's synthetic id as NOT synthetic here", () => {
    const foreign = deriveSyntheticId(OTHER, "client", 3);
    expect(isSyntheticId(foreign, STUDIO, "client", 500)).toBe(false);
  });

  it("fails closed beyond the ordinal ceiling", () => {
    const beyond = deriveSyntheticId(STUDIO, "client", ORDINAL_CEILING + 1);
    expect(isSyntheticId(beyond, STUDIO, "client", ORDINAL_CEILING)).toBe(false);
  });

  it("rejects malformed input rather than inventing an id", () => {
    expect(() => deriveSyntheticId("", "client", 0)).toThrow(TypeError);
    expect(() => deriveSyntheticId(STUDIO, "not_an_entity", 0)).toThrow(TypeError);
    expect(() => deriveSyntheticId(STUDIO, "client", -1)).toThrow(TypeError);
    expect(() => deriveSyntheticId(STUDIO, "client", 1.5)).toThrow(TypeError);
  });
});

describe("reconciliation is idempotent with no stored state", () => {
  it("a second run against an already-reconciled target plans nothing", () => {
    const first = buildPlan(SOURCE, EMPTY_TARGET);
    expect(first.clients.toCreate).toBe(50);

    const afterFirst = {
      syntheticClients: first.clients.desired,
      syntheticAppointments: first.appointments.desired,
      syntheticSessions: first.sessions.desired,
      syntheticIntakes: first.intakes.desired,
    };
    const second = buildPlan(SOURCE, afterFirst);
    expect(isNoOpPlan(second)).toBe(true);
  });

  it("re-running after a CRASH mid-write creates exactly the missing ordinals", () => {
    // Run 1 was interrupted after 20 of 50 clients.
    const resumed = buildPlan(SOURCE, { ...EMPTY_TARGET, syntheticClients: 20 });
    expect(resumed.clients.toCreate).toBe(30);
    expect(resumed.clients.ordinalRange).toEqual([20, 49]);

    // The rows it would write carry the ids the crashed run had not reached,
    // and none of the ids it already wrote.
    const rows = buildClientRows(STUDIO, 20, 49);
    expect(rows).toHaveLength(30);
    const already = new Set(buildClientRows(STUDIO, 0, 19).map((r: { id: string }) => r.id));
    for (const r of rows) expect(already.has(r.id)).toBe(false);
  });

  it("two CONCURRENT runs derive identical ids, so the second insert is a no-op", () => {
    const a = buildClientRows(STUDIO, 0, 49);
    const b = buildClientRows(STUDIO, 0, 49);
    expect(a.map((r: { id: string }) => r.id)).toEqual(b.map((r: { id: string }) => r.id));
    // `upsert(..., { onConflict: "id", ignoreDuplicates: true })` therefore
    // cannot double-create: there is no second distinct id to create.
    expect(new Set([...a, ...b].map((r: { id: string }) => r.id)).size).toBe(50);
  });

  it("a SOURCE COUNT DECREASE never plans a deletion", () => {
    const shrunk = { ...SOURCE, clients_total: 30 };
    const plan = buildPlan(shrunk, { ...EMPTY_TARGET, syntheticClients: 50 });
    expect(plan.clients.toCreate).toBe(0);
    expect(plan.clients.ordinalRange).toBeNull();
    expect(JSON.stringify(plan)).not.toMatch(/delete|remove|toDelete/i);
  });

  it("needs no watermark, timestamp or source id to be idempotent", () => {
    // buildPlan's entire input is two count objects. There is nowhere for a
    // watermark or a source identity to enter.
    expect(buildPlan.length).toBe(2);
    const plan = buildPlan(SOURCE, EMPTY_TARGET);
    expect(JSON.stringify(plan)).not.toMatch(/watermark|last_sync|since|cursor/i);
  });

  it("rejects a malformed profile instead of planning from garbage", () => {
    expect(() => buildPlan({ ...SOURCE, clients_total: "50" }, EMPTY_TARGET)).toThrow(TypeError);
  });
});

describe("the plan reproduces the source's aggregate shape", () => {
  const plan = buildPlan(SOURCE, EMPTY_TARGET);

  it("matches client scale exactly", () => {
    expect(plan.clients.toCreate).toBe(SOURCE.clients_total);
  });

  it("matches the appointment status distribution", () => {
    expect(plan.appointments.toCreate).toBe(totalAppointments(SOURCE));
    expect(plan.appointments.mix).toEqual({
      confirmed: 68, completed: 38, cancelled: 22, no_show: 2,
    });
  });

  it("matches the intake status distribution", () => {
    expect(plan.intakes.mix).toEqual({ in_progress: 19, submitted: 9, reviewed: 22 });
    expect(plan.intakes.toCreate).toBe(50);
  });

  it("matches the charting gap ratios", () => {
    expect(plan.sessions.toCreate).toBe(62);
    expect(plan.sessions.mix).toEqual({ missingAftercare: 26, withNextNote: 31 });
  });

  it("records what it deliberately skipped, rather than staying silent", () => {
    const skipped = plan.skipped.map((s: { what: string }) => s.what);
    expect(skipped).toContain("payment / ledger fixtures");
    expect(skipped).toContain("no_services studio blocker");
    expect(skipped).toContain("client email / phone");
  });

  it("paints the planned appointment statuses in the planned proportions", () => {
    const rows = buildAppointmentRows({
      studioId: STUDIO,
      clientIds: buildClientRows(STUDIO, 0, 49).map((c: { id: string }) => c.id),
      practitionerId: "11111111-1111-4111-8111-111111111111",
      serviceIds: ["22222222-2222-4222-8222-222222222222"],
      mix: plan.appointments.mix,
      fromOrdinal: 0,
      count: plan.appointments.toCreate,
      anchorMs: Date.UTC(2026, 7, 9),
    });
    expect(rows).toHaveLength(130);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    expect(counts).toEqual({ confirmed: 68, completed: 38, cancelled: 22, no_show: 2 });
  });

  it("keeps every confirmed appointment clear of the reminder windows", () => {
    const anchor = Date.UTC(2026, 7, 9);
    const rows = buildAppointmentRows({
      studioId: STUDIO,
      clientIds: ["33333333-3333-4333-8333-333333333333"],
      practitionerId: "11111111-1111-4111-8111-111111111111",
      serviceIds: [],
      mix: plan.appointments.mix,
      fromOrdinal: 0,
      count: 130,
      anchorMs: anchor,
    });
    // Defence in depth on top of NULL email: nothing confirmed lands inside the
    // 2h, 24h, 3d or 7d reminder windows the cron scans.
    for (const r of rows.filter((x: { status: string }) => x.status === "confirmed")) {
      const days = (new Date(r.starts_at).getTime() - anchor) / 86_400_000;
      expect(days).toBeGreaterThan(7.5);
    }
  });
});

describe("reset selects only provably synthetic rows", () => {
  it("deletes derivable ids and refuses everything else", () => {
    const derivable = syntheticIdSet(STUDIO, "client", 100);
    const mine = deriveSyntheticId(STUDIO, "client", 5);
    const real = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const foreign = deriveSyntheticId(OTHER, "client", 5);
    const beyond = deriveSyntheticId(STUDIO, "client", 900);

    const { deletable, refused } = selectResettableIds([mine, real, foreign, beyond], derivable);
    expect(deletable).toEqual([mine]);
    expect(refused).toEqual([real, foreign, beyond]);
  });

  it("refuses a target whose rows are entirely unprovable", () => {
    const derivable = syntheticIdSet(STUDIO, "client", 100);
    const realRows = [
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "b1e5f0a2-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
    ];
    const { deletable, refused } = selectResettableIds(realRows, derivable);
    expect(deletable).toHaveLength(0);
    expect(refused).toEqual(realRows);
  });

  it("partitions a mixed studio without touching the non-synthetic side", () => {
    const synthetic = Array.from({ length: 7 }, (_, i) => deriveSyntheticId(STUDIO, "client", i));
    const real = ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"];
    const part = partitionIds([...synthetic, ...real], STUDIO, "client", 100);
    expect(part.synthetic.sort()).toEqual([...synthetic].sort());
    expect(part.unknown).toEqual(real);
  });
});
