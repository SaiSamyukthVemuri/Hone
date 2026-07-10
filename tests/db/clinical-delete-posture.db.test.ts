import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #220 suite D: the migration 0087 clinical delete posture,
// proven on the REAL migrated local database instead of by SQL-text
// inspection. For each protected table a row is seeded as admin and
// then DELETEd as an authenticated studio MEMBER: with no DELETE
// policy the statement must affect zero rows and the row must
// survive. The four intentionally-deletable tables are the positive
// controls: the same member's DELETE must remove exactly one row.

let s: SeededStudio;
let sessionId: string;
let blockId: string;

beforeAll(async () => {
  s = await seedStudio("delete-posture");
  const seeded = await seedSession(s);
  sessionId = seeded.sessionId;
  blockId = seeded.blockId;
});

afterAll(async () => {
  await closePool();
});

type BlockedCase = {
  table: string;
  seed: () => Promise<string>;
};

const blockedCases: BlockedCase[] = [
  {
    table: "clients",
    // The seeded client from seedStudio.
    seed: async () => s.clientId,
  },
  {
    table: "sessions",
    seed: async () => sessionId,
  },
  {
    table: "session_blocks",
    seed: async () => blockId,
  },
  {
    table: "photos",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.photos (id, studio_id, client_id, storage_path)
         values ($1, $2, $3, $4)`,
        [id, s.studioId, s.clientId, `harness/${id}.jpg`],
      );
      return id;
    },
  },
  {
    table: "probe_lots",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.probe_lots (id, studio_id, probe_size)
         values ($1, $2, 'F3')`,
        [id, s.studioId],
      );
      return id;
    },
  },
  {
    table: "client_intake_forms",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.client_intake_forms (id, studio_id, client_id)
         values ($1, $2, $3)`,
        [id, s.studioId, s.clientId],
      );
      return id;
    },
  },
  {
    table: "client_tags",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.client_tags (id, studio_id, client_id, label)
         values ($1, $2, $3, 'harness-tag')`,
        [id, s.studioId, s.clientId],
      );
      return id;
    },
  },
  {
    table: "treatment_goals",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.treatment_goals
           (id, studio_id, client_id, estimated_total_minutes)
         values ($1, $2, $3, 120)`,
        [id, s.studioId, s.clientId],
      );
      return id;
    },
  },
  {
    table: "client_personal_notes",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.client_personal_notes (id, studio_id, client_id)
         values ($1, $2, $3)`,
        [id, s.studioId, s.clientId],
      );
      return id;
    },
  },
  // Migration 0115: treatment PASSES are now soft-delete-only. The
  // authenticated DELETE policy + grant (0087) were removed, so a member's
  // direct hard DELETE must now affect zero rows (removals go through the
  // soft-delete UPDATE path, PR #391). These two moved here from the
  // intentionally-deletable group below.
  {
    table: "electrolysis_entries",
    seed: async () => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.electrolysis_entries (id, session_id, area)
         values ($1, $2, 'chin')`,
        [id, sessionId],
      );
      return id;
    },
  },
  {
    table: "laser_entries",
    seed: async () => {
      const laserSessionId = randomUUID();
      await adminQuery(
        `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
         values ($1, $2, $3, $4, 'laser')`,
        [laserSessionId, s.studioId, s.clientId, s.practitionerId],
      );
      const id = randomUUID();
      await adminQuery(
        `insert into public.laser_entries (id, session_id, zone)
         values ($1, $2, 'upper lip')`,
        [id, laserSessionId],
      );
      return id;
    },
  },
];

describe("D: members cannot DELETE from protected clinical tables", () => {
  for (const c of blockedCases) {
    it(`${c.table}: DELETE affects zero rows and the row survives`, async () => {
      const id = await c.seed();
      const attempt = await userQuery(
        s.userId,
        `delete from public.${c.table} where id = $1`,
        [id],
      );
      expect(attempt.rowCount).toBe(0);
      const survives = await adminQuery(
        `select id from public.${c.table} where id = $1`,
        [id],
      );
      expect(survives.rowCount).toBe(1);
    });
  }
});

// Migration 0115: treatment passes are soft-delete-only. A member's direct
// hard DELETE is blocked (covered by the blockedCases loop above), but the
// approved soft-delete UPDATE path (PR #391) must still work same-studio, and
// cross-studio access stays blocked.
describe("D: treatment passes are soft-delete-only after 0115", () => {
  it("member CAN soft-delete an electrolysis pass via UPDATE (Remove pass path intact)", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries (id, session_id, area)
       values ($1, $2, 'chin')`,
      [id, sessionId],
    );
    const upd = await userQuery(
      s.userId,
      `update public.electrolysis_entries
         set deleted_at = now(), deleted_by = $2, delete_reason = 'test'
       where id = $1 and deleted_at is null`,
      [id, s.practitionerId],
    );
    expect(upd.rowCount).toBe(1);
    // Already-removed pass cannot be voided again (guarded by deleted_at is null).
    const again = await userQuery(
      s.userId,
      `update public.electrolysis_entries
         set deleted_at = now()
       where id = $1 and deleted_at is null`,
      [id],
    );
    expect(again.rowCount).toBe(0);
    // The row still physically exists (soft, not hard).
    const survives = await adminQuery(
      `select deleted_at from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(survives.rowCount).toBe(1);
    expect(survives.rows[0].deleted_at).not.toBeNull();
  });

  it("a DIFFERENT studio's member cannot hard-delete OR read this studio's electrolysis pass", async () => {
    const other = await seedStudio("delete-posture-other");
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries (id, session_id, area)
       values ($1, $2, 'chin')`,
      [id, sessionId],
    );
    const del = await userQuery(
      other.userId,
      `delete from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(del.rowCount).toBe(0);
    const read = await userQuery(
      other.userId,
      `select id from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(read.rowCount).toBe(0);
  });
});

describe("D: intentionally-deletable tables still allow member DELETE", () => {
  it("treatment_plan_stages: member DELETE removes the row", async () => {
    const planId = randomUUID();
    await adminQuery(
      `insert into public.treatment_plans (id, studio_id, client_id, name)
       values ($1, $2, $3, 'Harness plan')`,
      [planId, s.studioId, s.clientId],
    );
    const id = randomUUID();
    await adminQuery(
      `insert into public.treatment_plan_stages
         (id, plan_id, studio_id, how_often_unit, visit_length_minutes,
          stage_length_value, stage_length_unit)
       values ($1, $2, $3, 'weekly', 30, 4, 'weeks')`,
      [id, planId, s.studioId],
    );
    const attempt = await userQuery(
      s.userId,
      `delete from public.treatment_plan_stages where id = $1`,
      [id],
    );
    expect(attempt.rowCount).toBe(1);
  });

  it("client_pricing: member DELETE removes the row", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.client_pricing (id, studio_id, service_name, price_cents)
       values ($1, $2, 'Harness 30 min', 5000)`,
      [id, s.studioId],
    );
    const attempt = await userQuery(
      s.userId,
      `delete from public.client_pricing where id = $1`,
      [id],
    );
    expect(attempt.rowCount).toBe(1);
  });
});

describe("D: cross-studio members cannot use the allowed DELETEs either", () => {
  it("a stranger's DELETE on electrolysis_entries affects zero rows", async () => {
    const stranger = await seedStudio("delete-stranger");
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries (id, session_id, area)
       values ($1, $2, 'brow')`,
      [id, sessionId],
    );
    const attempt = await userQuery(
      stranger.userId,
      `delete from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(attempt.rowCount).toBe(0);
    const survives = await adminQuery(
      `select id from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(survives.rowCount).toBe(1);
  });
});
