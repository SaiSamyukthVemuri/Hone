import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #252 (migration 0089): Imported Treatment Memory, proven on the
// REAL migrated local database.
//
//   import_batches / imported_treatment_memories
//     SELECT  any active member        INSERT  owner only
//     UPDATE  owner only (soft void)    DELETE  nobody (no policy)
//   imported_treatment_memory_audit_events
//     SELECT  any active member; written ONLY by the security-definer
//     trigger (append-only), studio-scoped, cross-studio isolated.
//
// Plus: source_type CHECK, required client_id, and import_batch_id
// on delete RESTRICT.

let s: SeededStudio; // owner studio
let member: { userId: string; practitionerId: string };
let foreign: SeededStudio;
let batchId: string;
let memoryId: string;

beforeAll(async () => {
  s = await seedStudio("imported");
  member = await seedMember(s, "imported-member");
  foreign = await seedStudio("imported-foreign");
  batchId = randomUUID();
  memoryId = randomUUID();

  // The OWNER imports a batch and a memory (so audit rows carry a real
  // actor and the rows exist for read/void/cross-studio assertions).
  await userQuery(
    s.userId,
    `insert into public.import_batches
       (id, studio_id, source_type, source_label, row_count, created_by)
     values ($1, $2, 'paper_card', '2019 cards', 1, $3)`,
    [batchId, s.studioId, s.userId],
  );
  await userQuery(
    s.userId,
    `insert into public.imported_treatment_memories
       (id, studio_id, client_id, import_batch_id, source_type,
        treatment_area_text, tolerance_text, imported_by)
     values ($1, $2, $3, $4, 'paper_card', 'Upper lip', 'tolerated well', $5)`,
    [memoryId, s.studioId, s.clientId, batchId, s.userId],
  );
});

afterAll(async () => {
  await closePool();
});

describe("owner imports; the audit trigger records 'created' with the owner as actor", () => {
  it("the seeded batch + memory exist (owner INSERT succeeded)", async () => {
    const b = await adminQuery(
      `select id from public.import_batches where id = $1`,
      [batchId],
    );
    const m = await adminQuery(
      `select id from public.imported_treatment_memories where id = $1`,
      [memoryId],
    );
    expect(b.rowCount).toBe(1);
    expect(m.rowCount).toBe(1);
  });

  it("a 'created' audit event was written for each, with the owner practitioner as actor", async () => {
    const batchAudit = await adminQuery(
      `select action, actor_practitioner_id, actor_user_id
         from public.imported_treatment_memory_audit_events
        where record_type = 'import_batch' and record_id = $1`,
      [batchId],
    );
    expect(batchAudit.rowCount).toBe(1);
    expect(batchAudit.rows[0].action).toBe("created");
    expect(batchAudit.rows[0].actor_practitioner_id).toBe(s.practitionerId);
    expect(batchAudit.rows[0].actor_user_id).toBe(s.userId);

    const memAudit = await adminQuery(
      `select action from public.imported_treatment_memory_audit_events
        where record_type = 'imported_treatment_memory' and record_id = $1`,
      [memoryId],
    );
    expect(memAudit.rowCount).toBe(1);
    expect(memAudit.rows[0].action).toBe("created");
  });
});

describe("write access: owner only", () => {
  it("a non-owner member cannot INSERT an import batch", async () => {
    await expect(
      userQuery(
        member.userId,
        `insert into public.import_batches (id, studio_id, source_type)
         values ($1, $2, 'jane')`,
        [randomUUID(), s.studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a non-owner member cannot INSERT an imported memory", async () => {
    await expect(
      userQuery(
        member.userId,
        `insert into public.imported_treatment_memories
           (id, studio_id, client_id, import_batch_id, source_type)
         values ($1, $2, $3, $4, 'jane')`,
        [randomUUID(), s.studioId, s.clientId, batchId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an owner of ANOTHER studio cannot INSERT into this studio", async () => {
    await expect(
      userQuery(
        foreign.userId,
        `insert into public.import_batches (id, studio_id, source_type)
         values ($1, $2, 'spreadsheet')`,
        [randomUUID(), s.studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("read access: same-studio members yes, cross-studio no", () => {
  it("a studio member can SELECT import batches and imported memories", async () => {
    const batches = await userQuery(
      member.userId,
      `select id from public.import_batches where studio_id = $1`,
      [s.studioId],
    );
    const memories = await userQuery(
      member.userId,
      `select id from public.imported_treatment_memories where studio_id = $1`,
      [s.studioId],
    );
    expect(Number(batches.rowCount)).toBeGreaterThanOrEqual(1);
    expect(Number(memories.rowCount)).toBeGreaterThanOrEqual(1);
  });

  it("a cross-studio user sees neither batches nor memories", async () => {
    const batches = await userQuery(
      foreign.userId,
      `select id from public.import_batches where studio_id = $1 or id = $2`,
      [s.studioId, batchId],
    );
    const memories = await userQuery(
      foreign.userId,
      `select id from public.imported_treatment_memories where studio_id = $1 or id = $2`,
      [s.studioId, memoryId],
    );
    expect(batches.rowCount).toBe(0);
    expect(memories.rowCount).toBe(0);
  });
});

describe("correction: owner soft-voids (UPDATE), nobody hard-deletes", () => {
  it("a non-owner member cannot void (UPDATE) a memory", async () => {
    const r = await userQuery(
      member.userId,
      `update public.imported_treatment_memories
          set voided_at = now(), void_reason = 'member tamper'
        where id = $1`,
      [memoryId],
    );
    expect(r.rowCount).toBe(0);
  });

  it("a cross-studio user cannot void a memory", async () => {
    const r = await userQuery(
      foreign.userId,
      `update public.imported_treatment_memories
          set voided_at = now() where id = $1`,
      [memoryId],
    );
    expect(r.rowCount).toBe(0);
  });

  it("the owner CAN void a memory, and the audit logs 'updated' including voided_at", async () => {
    const r = await userQuery(
      s.userId,
      `update public.imported_treatment_memories
          set voided_at = now(), voided_by = $2, void_reason = 'duplicate paste'
        where id = $1`,
      [memoryId, s.userId],
    );
    expect(r.rowCount).toBe(1);
    const audit = await adminQuery(
      `select action, changed_fields, actor_practitioner_id, actor_user_id
         from public.imported_treatment_memory_audit_events
        where record_type = 'imported_treatment_memory'
          and record_id = $1 and action = 'updated'`,
      [memoryId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].changed_fields).toContain("voided_at");
    expect(audit.rows[0].changed_fields).toContain("void_reason");
    // The acting owner is resolved into the audit event.
    expect(audit.rows[0].actor_practitioner_id).toBe(s.practitionerId);
    expect(audit.rows[0].actor_user_id).toBe(s.userId);
  });

  it("the owner CAN void a whole batch", async () => {
    const r = await userQuery(
      s.userId,
      `update public.import_batches
          set voided_at = now(), voided_by = $2, void_reason = 'wrong file'
        where id = $1`,
      [batchId, s.userId],
    );
    expect(r.rowCount).toBe(1);
  });

  it("neither member nor owner can hard-DELETE imported memory; the row survives", async () => {
    // DELETE is revoked from authenticated (privilege layer), so the
    // attempt errors before RLS — there is no silent no-op delete path.
    await expect(
      userQuery(
        member.userId,
        `delete from public.imported_treatment_memories where id = $1`,
        [memoryId],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      userQuery(
        s.userId,
        `delete from public.imported_treatment_memories where id = $1`,
        [memoryId],
      ),
    ).rejects.toThrow(/permission denied/i);
    const survives = await adminQuery(
      `select id from public.imported_treatment_memories where id = $1`,
      [memoryId],
    );
    expect(survives.rowCount).toBe(1);
  });

  it("neither member nor owner can hard-DELETE an import batch; the row survives", async () => {
    await expect(
      userQuery(s.userId, `delete from public.import_batches where id = $1`, [batchId]),
    ).rejects.toThrow(/permission denied/i);
    const survives = await adminQuery(
      `select id from public.import_batches where id = $1`,
      [batchId],
    );
    expect(survives.rowCount).toBe(1);
  });

  it("no authenticated user can TRUNCATE any of the three tables (RLS-exempt hole closed)", async () => {
    for (const table of [
      "public.imported_treatment_memories",
      "public.import_batches",
      "public.imported_treatment_memory_audit_events",
    ]) {
      await expect(
        userQuery(s.userId, `truncate ${table}`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        userQuery(member.userId, `truncate ${table} cascade`),
      ).rejects.toThrow(/permission denied/i);
    }
    // Rows survive the attempts.
    const m = await adminQuery(
      `select id from public.imported_treatment_memories where id = $1`,
      [memoryId],
    );
    expect(m.rowCount).toBe(1);
  });
});

describe("audit trail: member-readable, cross-studio isolated, append-only", () => {
  it("a member can read the import audit trail; a cross-studio user cannot", async () => {
    const memberView = await userQuery(
      member.userId,
      `select id from public.imported_treatment_memory_audit_events
        where studio_id = $1`,
      [s.studioId],
    );
    expect(Number(memberView.rowCount)).toBeGreaterThanOrEqual(2);
    const foreignView = await userQuery(
      foreign.userId,
      `select id from public.imported_treatment_memory_audit_events
        where studio_id = $1`,
      [s.studioId],
    );
    expect(foreignView.rowCount).toBe(0);
  });

  it("no normal authenticated user can INSERT, UPDATE, or DELETE audit rows (privilege-revoked, trigger-only)", async () => {
    // INSERT/UPDATE/DELETE are revoked from authenticated on the audit
    // table, so every direct write errors at the privilege layer; rows are
    // written ONLY by the security-definer trigger.
    await expect(
      userQuery(
        s.userId,
        `insert into public.imported_treatment_memory_audit_events
           (studio_id, record_type, record_id, action)
         values ($1, 'import_batch', $2, 'created')`,
        [s.studioId, randomUUID()],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      userQuery(
        s.userId,
        `update public.imported_treatment_memory_audit_events
            set action = 'updated' where studio_id = $1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      userQuery(
        s.userId,
        `delete from public.imported_treatment_memory_audit_events where studio_id = $1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("constraints: provenance, required client, restricted batch FK", () => {
  it("source_type is constrained to the known set", async () => {
    await expect(
      adminQuery(
        `insert into public.import_batches (id, studio_id, source_type)
         values ($1, $2, 'square')`,
        [randomUUID(), s.studioId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("client_id is required on imported memory", async () => {
    await expect(
      adminQuery(
        `insert into public.imported_treatment_memories
           (id, studio_id, client_id, import_batch_id, source_type)
         values ($1, $2, null, $3, 'paper_card')`,
        [randomUUID(), s.studioId, batchId],
      ),
    ).rejects.toThrow(/not-null|null value/i);
  });

  it("a batch with imported memories cannot be hard-deleted (on delete RESTRICT)", async () => {
    // Fresh, isolated pair so this never depends on other tests.
    const b = randomUUID();
    const m = randomUUID();
    await adminQuery(
      `insert into public.import_batches (id, studio_id, source_type)
       values ($1, $2, 'spreadsheet')`,
      [b, s.studioId],
    );
    await adminQuery(
      `insert into public.imported_treatment_memories
         (id, studio_id, client_id, import_batch_id, source_type)
       values ($1, $2, $3, $4, 'spreadsheet')`,
      [m, s.studioId, s.clientId, b],
    );
    await expect(
      adminQuery(`delete from public.import_batches where id = $1`, [b]),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
