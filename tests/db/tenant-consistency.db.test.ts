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

// PR #278 (migration 0094): tenant-consistency composite FKs on clinical/import
// child tables, proven on the REAL migrated local database. A child row may never
// carry studio_id=A while pointing at a parent (client/session/import batch) from
// studio B — and an electrolysis entry's block must belong to its own session.
// adminQuery (service role) is used for the FK-violation cases to prove the
// constraint holds even for the service role (the strongest guarantee); a
// userQuery pair shows the authenticated path; an RLS read check is the regression.

let s: SeededStudio; // studio A
let foreign: SeededStudio; // studio B
let aSession: { sessionId: string; blockId: string };
let bSession: { sessionId: string; blockId: string };
let aBatch: string;
let bBatch: string;

async function seedBatch(studioId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    "insert into public.import_batches (id, studio_id) values ($1, $2)",
    [id, studioId],
  );
  return id;
}

beforeAll(async () => {
  s = await seedStudio("tenant");
  foreign = await seedStudio("tenant-foreign");
  aSession = await seedSession(s);
  bSession = await seedSession(foreign);
  aBatch = await seedBatch(s.studioId);
  bBatch = await seedBatch(foreign.studioId);
});

afterAll(async () => {
  await closePool();
});

describe("sessions: client + studio must match", () => {
  it("rejects a session whose client is from another studio (service role)", async () => {
    await expect(
      adminQuery(
        `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
         values ($1,$2,$3,$4,'electrolysis')`,
        [randomUUID(), s.studioId, foreign.clientId, s.practitionerId],
      ),
    ).rejects.toThrow();
  });
  it("an authenticated studio-A member also cannot (RLS passes, FK fails)", async () => {
    await expect(
      userQuery(
        s.userId,
        `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
         values ($1,$2,$3,$4,'electrolysis')`,
        [randomUUID(), s.studioId, foreign.clientId, s.practitionerId],
      ),
    ).rejects.toThrow();
  });
  it("accepts a same-studio session (authenticated + service role)", async () => {
    const a = await userQuery(
      s.userId,
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,$4,'electrolysis')`,
      [randomUUID(), s.studioId, s.clientId, s.practitionerId],
    );
    expect(a.rowCount).toBe(1);
    const b = await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,$4,'electrolysis')`,
      [randomUUID(), s.studioId, s.clientId, s.practitionerId],
    );
    expect(b.rowCount).toBe(1);
  });
  it("rejects UPDATE that re-points a session's client cross-studio", async () => {
    await expect(
      adminQuery(
        "update public.sessions set client_id=$1 where id=$2",
        [foreign.clientId, aSession.sessionId],
      ),
    ).rejects.toThrow();
  });
  it("client delete still cascades to its sessions", async () => {
    const clientId = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'casc')", [clientId, s.studioId]);
    const sessId = randomUUID();
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,$4,'electrolysis')`,
      [sessId, s.studioId, clientId, s.practitionerId],
    );
    await adminQuery("delete from public.clients where id=$1", [clientId]);
    const r = await adminQuery("select id from public.sessions where id=$1", [sessId]);
    expect(r.rowCount).toBe(0);
  });
});

describe("session_blocks: session + studio must match", () => {
  it("rejects a block whose session is from another studio", async () => {
    await expect(
      adminQuery(
        "insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)",
        [randomUUID(), s.studioId, bSession.sessionId],
      ),
    ).rejects.toThrow();
  });
  it("accepts a same-studio block", async () => {
    const r = await adminQuery(
      "insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)",
      [randomUUID(), s.studioId, aSession.sessionId],
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("client_intake_forms + treatment_plans: client + studio must match", () => {
  it("rejects an intake form with a cross-studio client", async () => {
    await expect(
      adminQuery(
        "insert into public.client_intake_forms (id, studio_id, client_id) values ($1,$2,$3)",
        [randomUUID(), s.studioId, foreign.clientId],
      ),
    ).rejects.toThrow();
  });
  it("accepts a same-studio intake form", async () => {
    const r = await adminQuery(
      "insert into public.client_intake_forms (id, studio_id, client_id) values ($1,$2,$3)",
      [randomUUID(), s.studioId, s.clientId],
    );
    expect(r.rowCount).toBe(1);
  });
  it("rejects a treatment plan with a cross-studio client", async () => {
    await expect(
      adminQuery(
        "insert into public.treatment_plans (id, studio_id, client_id, name) values ($1,$2,$3,'p')",
        [randomUUID(), s.studioId, foreign.clientId],
      ),
    ).rejects.toThrow();
  });
  it("accepts a same-studio treatment plan", async () => {
    const r = await adminQuery(
      "insert into public.treatment_plans (id, studio_id, client_id, name) values ($1,$2,$3,'p')",
      [randomUUID(), s.studioId, s.clientId],
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("imported_treatment_memories: client + import batch must be same-studio", () => {
  it("rejects a cross-studio client", async () => {
    await expect(
      adminQuery(
        "insert into public.imported_treatment_memories (id, studio_id, client_id, import_batch_id) values ($1,$2,$3,$4)",
        [randomUUID(), s.studioId, foreign.clientId, aBatch],
      ),
    ).rejects.toThrow();
  });
  it("rejects a cross-studio import batch", async () => {
    await expect(
      adminQuery(
        "insert into public.imported_treatment_memories (id, studio_id, client_id, import_batch_id) values ($1,$2,$3,$4)",
        [randomUUID(), s.studioId, s.clientId, bBatch],
      ),
    ).rejects.toThrow();
  });
  it("accepts same-studio client + batch", async () => {
    const r = await adminQuery(
      "insert into public.imported_treatment_memories (id, studio_id, client_id, import_batch_id) values ($1,$2,$3,$4)",
      [randomUUID(), s.studioId, s.clientId, aBatch],
    );
    expect(r.rowCount).toBe(1);
  });
  it("import-batch delete is RESTRICTed while a memory references it", async () => {
    const batch = await seedBatch(s.studioId);
    await adminQuery(
      "insert into public.imported_treatment_memories (id, studio_id, client_id, import_batch_id) values ($1,$2,$3,$4)",
      [randomUUID(), s.studioId, s.clientId, batch],
    );
    await expect(
      adminQuery("delete from public.import_batches where id=$1", [batch]),
    ).rejects.toThrow();
  });
});

describe("electrolysis_entries: attached block must belong to the same session", () => {
  it("rejects an entry whose block is from a different session", async () => {
    await expect(
      adminQuery(
        "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'chin')",
        [randomUUID(), aSession.sessionId, bSession.blockId],
      ),
    ).rejects.toThrow();
  });
  it("accepts an entry whose block belongs to its session", async () => {
    const r = await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'chin')",
      [randomUUID(), aSession.sessionId, aSession.blockId],
    );
    expect(r.rowCount).toBe(1);
  });
  it("a NULL block is allowed (detach), and block delete SET-NULLs the entry", async () => {
    // fresh session + block so deleting the block does not disturb other tests
    const sess = await seedSession(s);
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'lip')",
      [entryId, sess.sessionId, sess.blockId],
    );
    await adminQuery("delete from public.session_blocks where id=$1", [sess.blockId]);
    const r = await adminQuery("select block_id from public.electrolysis_entries where id=$1", [entryId]);
    expect(r.rows[0]?.block_id).toBeNull();
  });
});

describe("exactly one FK relationship per pair (PostgREST embed ambiguity guard)", () => {
  // PR #278 fix: the composite FK REPLACES the single FK, so each table pair has
  // exactly one relationship — otherwise PostgREST embedded selects (e.g.
  // sessions.select("... session_blocks(...)")) fail with "more than one
  // relationship was found".
  async function fkCount(child: string, parent: string): Promise<number> {
    const r = await adminQuery(
      `select count(*)::int as n from pg_constraint
        where contype='f' and conrelid=$1::regclass and confrelid=$2::regclass`,
      [`public.${child}`, `public.${parent}`],
    );
    return r.rows[0].n as number;
  }
  it("session_blocks->sessions, sessions->clients/appointments, etc. each have one FK", async () => {
    expect(await fkCount("session_blocks", "sessions")).toBe(1);
    expect(await fkCount("sessions", "clients")).toBe(1);
    expect(await fkCount("sessions", "appointments")).toBe(1);
    expect(await fkCount("client_intake_forms", "clients")).toBe(1);
    expect(await fkCount("imported_treatment_memories", "clients")).toBe(1);
    expect(await fkCount("imported_treatment_memories", "import_batches")).toBe(1);
    expect(await fkCount("treatment_plans", "clients")).toBe(1);
    expect(await fkCount("electrolysis_entries", "session_blocks")).toBe(1);
  });
  it("electrolysis_entries->sessions keeps its single FK (different pair)", async () => {
    expect(await fkCount("electrolysis_entries", "sessions")).toBe(1);
  });
});

describe("RLS regression: cross-studio reads still blocked", () => {
  it("a foreign-studio member cannot read studio A's sessions", async () => {
    const r = await userQuery(
      foreign.userId,
      "select id from public.sessions where studio_id=$1",
      [s.studioId],
    );
    expect(r.rowCount).toBe(0);
  });
});
