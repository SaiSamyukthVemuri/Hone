import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// PR #318. getClientProcedureRecords (lib/record-keeping/queries.ts) must
// exclude soft-deleted sessions (migration 0013) so a session deleted as a
// correction never appears in Procedure Records / the inspection print/export.
// The TS function runs through the RLS `createClient()` (not buildable here), so
// this exercises the EXACT sessions filter it now issues against the REAL
// migrated DB, as the studio's authenticated member.

// Mirrors the function's sessions query (studio-scoped + PR #318 deleted_at
// filter), ordered/limited like getClientProcedureRecords:
const FILTERED_SQL = `
  select id
  from public.sessions
  where studio_id = $1
    and deleted_at is null
  order by started_at desc
  limit 30
`;

let s: SeededStudio;
let activeId: string;
let deletedId: string;

beforeAll(async () => {
  s = await seedStudio("rk-procedure-softdelete");
  const active = await seedSession(s);
  const deleted = await seedSession(s);
  activeId = active.sessionId;
  deletedId = deleted.sessionId;
  // Soft-delete the second session (what DeleteSessionForm does).
  await adminQuery(
    "update public.sessions set deleted_at = now() where id = $1",
    [deletedId],
  );
});

afterAll(async () => {
  await closePool();
});

describe("getClientProcedureRecords sessions filter on the real migrated DB", () => {
  it("returns the active session and EXCLUDES the soft-deleted one", async () => {
    const res = await asUser(s.userId, (q) => q(FILTERED_SQL, [s.studioId]));
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });

  it("without the deleted_at filter the soft-deleted session WOULD leak (proves the filter is the exclusion)", async () => {
    const res = await asUser(s.userId, (q) =>
      q(
        "select id from public.sessions where studio_id = $1 order by started_at desc limit 30",
        [s.studioId],
      ),
    );
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(deletedId); // visible only because the filter is absent
  });
});
