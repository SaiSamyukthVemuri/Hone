import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// ===========================================================================
// "Remove pass" after the L18 FINAL revocation (migration 0169) — behavioural.
// ===========================================================================
//
// 0169 revoked INSERT/UPDATE/DELETE from `authenticated` on electrolysis_entries
// and laser_entries, leaving SELECT. `softDeleteEntry` was still writing through
// the AUTHENTICATED client, so the practitioner-facing Remove pass action began
// failing in production with 42501. The repair moves ONLY that final mutation to
// the service-role client, after the existing authenticated actor + lineage
// checks.
//
// Service_role BYPASSES RLS, so the mutation's own filter is now the whole
// tenant boundary. That is what this suite proves on the REAL migrated local
// database rather than by reading the source: the exact production statement is
// executed here, and every isolation property is asserted against real rows.
//
// THE STATEMENT UNDER TEST — byte-for-byte the predicate the action issues
// (`.eq("id").eq("session_id").is("deleted_at", null).select("id")`):
const SOFT_DELETE = (table: "electrolysis_entries" | "laser_entries") => `
  update public.${table}
     set deleted_at = now(), deleted_by = $1, delete_reason = $2
   where id = $3 and session_id = $4 and deleted_at is null
  returning id`;

// GOTCHA (harness): asRole() ALWAYS rolls back, so every assertion about a write
// must happen INSIDE the callback. Rows seeded for later reads use adminQuery.

let studioA: SeededStudio;
let studioB: SeededStudio;
let sessionA: string;
let sessionB: string;

async function seedElectrolysisEntry(sessionId: string, area: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.electrolysis_entries (id, session_id, area) values ($1, $2, $3)`,
    [id, sessionId, area],
  );
  return id;
}

async function seedLaserEntry(sessionId: string, zone: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.laser_entries (id, session_id, zone) values ($1, $2, $3)`,
    [id, sessionId, zone],
  );
  return id;
}

beforeAll(async () => {
  studioA = await seedStudio("remove-pass-a");
  studioB = await seedStudio("remove-pass-b");
  sessionA = (await seedSession(studioA)).sessionId;
  sessionB = (await seedSession(studioB)).sessionId;
});

afterAll(async () => {
  await closePool();
});

describe("0169 privilege boundary is INTACT after the hotfix", () => {
  it("authenticated cannot UPDATE electrolysis_entries (42501)", async () => {
    const entryId = await seedElectrolysisEntry(sessionA, "chin");
    await expect(
      asRole("authenticated", (q) =>
        q(`update public.electrolysis_entries set deleted_at = now() where id = $1`, [
          entryId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated cannot UPDATE laser_entries (42501)", async () => {
    const entryId = await seedLaserEntry(sessionA, "leg");
    await expect(
      asRole("authenticated", (q) =>
        q(`update public.laser_entries set deleted_at = now() where id = $1`, [entryId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the hotfix does NOT restore authenticated INSERT or DELETE either", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`insert into public.electrolysis_entries (session_id, area) values ($1, 'x')`, [
          sessionA,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("authenticated", (q) =>
        q(`delete from public.laser_entries where session_id = $1`, [sessionA]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated SELECT is RETAINED (read paths must keep working)", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select id from public.electrolysis_entries where session_id = $1`, [sessionA]),
      ),
    ).resolves.toBeDefined();
  });
});

describe("the service-role soft-delete affects exactly the selected pass", () => {
  it("removes ONE electrolysis pass and leaves its sibling active", async () => {
    const target = await seedElectrolysisEntry(sessionA, "chin");
    const sibling = await seedElectrolysisEntry(sessionA, "chin"); // same area

    await asRole("service_role", async (q) => {
      const res = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        "wrong area",
        target,
        sessionA,
      ]);
      expect(res.rowCount, "exactly one row must change").toBe(1);

      const t = await q(
        `select deleted_at, deleted_by, delete_reason from public.electrolysis_entries where id = $1`,
        [target],
      );
      expect(t.rows[0].deleted_at).not.toBeNull();
      expect(t.rows[0].deleted_by).toBe(studioA.practitionerId);
      expect(t.rows[0].delete_reason).toBe("wrong area");

      // The other pass in the SAME area of the SAME session is untouched.
      const s = await q(
        `select deleted_at from public.electrolysis_entries where id = $1`,
        [sibling],
      );
      expect(s.rows[0].deleted_at, "sibling pass must stay active").toBeNull();
    });
  });

  it("removes ONE laser pass", async () => {
    const target = await seedLaserEntry(sessionA, "leg");
    await asRole("service_role", async (q) => {
      const res = await q(SOFT_DELETE("laser_entries"), [
        studioA.practitionerId,
        null,
        target,
        sessionA,
      ]);
      expect(res.rowCount).toBe(1);
      const t = await q(
        `select deleted_at, deleted_by, delete_reason from public.laser_entries where id = $1`,
        [target],
      );
      expect(t.rows[0].deleted_at).not.toBeNull();
      expect(t.rows[0].deleted_by).toBe(studioA.practitionerId);
      // An omitted optional reason stores NULL, per the existing contract.
      expect(t.rows[0].delete_reason).toBeNull();
    });
  });

  it("is a SOFT delete — the clinical row survives and is never hard-deleted", async () => {
    const target = await seedElectrolysisEntry(sessionA, "lip");
    await asRole("service_role", async (q) => {
      await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        target,
        sessionA,
      ]);
      const still = await q(
        `select count(*)::int n from public.electrolysis_entries where id = $1`,
        [target],
      );
      expect(still.rows[0].n, "the row must still exist").toBe(1);
    });
  });

  it("leaves the parent session and block active", async () => {
    const target = await seedElectrolysisEntry(sessionA, "neck");
    await asRole("service_role", async (q) => {
      await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        target,
        sessionA,
      ]);
      const sess = await q(`select deleted_at from public.sessions where id = $1`, [
        sessionA,
      ]);
      expect(sess.rows[0].deleted_at, "the session must stay active").toBeNull();
      const blocks = await q(
        `select count(*)::int n from public.session_blocks where session_id = $1 and deleted_at is null`,
        [sessionA],
      );
      expect(blocks.rows[0].n, "the block must stay active").toBeGreaterThan(0);
    });
  });
});

describe("lineage isolation — the filter is the whole tenant boundary", () => {
  it("cannot remove an entry through an UNRELATED session id", async () => {
    const target = await seedElectrolysisEntry(sessionA, "chin");
    const unrelated = randomUUID();
    await asRole("service_role", async (q) => {
      const res = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        target,
        unrelated,
      ]);
      expect(res.rowCount, "session_id mismatch must affect zero rows").toBe(0);
    });
  });

  it("cannot remove ANOTHER STUDIO's entry using this studio's session id", async () => {
    // studio B's pass, addressed with studio A's session — the shape a forged
    // entry id would take once the actor has passed A's own lineage check.
    const foreign = await seedElectrolysisEntry(sessionB, "chin");
    await asRole("service_role", async (q) => {
      const res = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        foreign,
        sessionA,
      ]);
      expect(res.rowCount, "cross-studio removal must affect zero rows").toBe(0);
      const survived = await q(
        `select deleted_at from public.electrolysis_entries where id = $1`,
        [foreign],
      );
      expect(survived.rows[0].deleted_at).toBeNull();
    });
  });

  it("cannot remove another CLIENT's entry (different session, same studio)", async () => {
    const otherSession = (await seedSession(studioA)).sessionId;
    const otherEntry = await seedElectrolysisEntry(otherSession, "chin");
    await asRole("service_role", async (q) => {
      const res = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        otherEntry,
        sessionA,
      ]);
      expect(res.rowCount).toBe(0);
    });
  });

  it("never mass-updates: the predicate is pinned to one primary key", async () => {
    await seedElectrolysisEntry(sessionA, "mass-a");
    await seedElectrolysisEntry(sessionA, "mass-b");
    const target = await seedElectrolysisEntry(sessionA, "mass-c");
    await asRole("service_role", async (q) => {
      const before = await q(
        `select count(*)::int n from public.electrolysis_entries where session_id = $1 and deleted_at is null`,
        [sessionA],
      );
      const res = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        null,
        target,
        sessionA,
      ]);
      expect(res.rowCount).toBe(1);
      const after = await q(
        `select count(*)::int n from public.electrolysis_entries where session_id = $1 and deleted_at is null`,
        [sessionA],
      );
      expect(
        before.rows[0].n - after.rows[0].n,
        "exactly one active pass may disappear",
      ).toBe(1);
    });
  });
});

describe("double-remove is a safe failure, not a silent success", () => {
  it("a second removal affects zero rows and does not restamp the first", async () => {
    const target = await seedElectrolysisEntry(sessionA, "chin");
    await asRole("service_role", async (q) => {
      const first = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        "first",
        target,
        sessionA,
      ]);
      expect(first.rowCount).toBe(1);
      const stamped = await q(
        `select deleted_at, delete_reason from public.electrolysis_entries where id = $1`,
        [target],
      );

      const second = await q(SOFT_DELETE("electrolysis_entries"), [
        studioA.practitionerId,
        "second",
        target,
        sessionA,
      ]);
      expect(second.rowCount, "the active-only guard must reject a double-void").toBe(0);

      const after = await q(
        `select deleted_at, delete_reason from public.electrolysis_entries where id = $1`,
        [target],
      );
      expect(after.rows[0].deleted_at).toEqual(stamped.rows[0].deleted_at);
      expect(after.rows[0].delete_reason, "the original reason must survive").toBe("first");
    });
  });
});
