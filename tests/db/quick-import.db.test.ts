import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #257: Quick Import V1 — the live RLS write path on the real migrated DB.
// PR #252 already proved table-level RLS/constraints/audit; this proves the
// IMPORT-SHAPED write: an OWNER can create a batch + a client + multiple
// grouped imported-memory rows through the authenticated (RLS) client, the
// rows land studio-scoped and linked, and the import touches NO live charting
// (sessions) or booking (appointments). A non-owner cannot import.

let s: SeededStudio;
let member: { userId: string; practitionerId: string };

beforeAll(async () => {
  s = await seedStudio("quickimport");
  member = await seedMember(s, "quickimport-member");
});

afterAll(async () => {
  await closePool();
});

describe("owner import write path (the action's RLS-backed inserts)", () => {
  it("creates a batch + a client + multiple grouped memory rows, with no sessions/appointments", async () => {
    const batchId = randomUUID();
    const clientId = randomUUID();

    await userQuery(
      s.userId,
      `insert into public.import_batches (id, studio_id, source_type, source_label, row_count, created_by)
       values ($1, $2, 'paper_card', 'CSV/TSV import', 2, $3)`,
      [batchId, s.studioId, s.userId],
    );
    // Owner is an active member, so the clients member-INSERT policy allows it.
    await userQuery(
      s.userId,
      `insert into public.clients (id, studio_id, name) values ($1, $2, 'Imported Maya')`,
      [clientId, s.studioId],
    );
    // Two treatment areas for ONE client -> two imported_treatment_memories.
    await userQuery(
      s.userId,
      `insert into public.imported_treatment_memories
         (studio_id, client_id, import_batch_id, source_type, treatment_area_text, source_row_number)
       values ($1,$2,$3,'paper_card','Upper lip',1), ($1,$2,$3,'paper_card','Chin',2)`,
      [s.studioId, clientId, batchId],
    );

    const mems = await adminQuery(
      `select treatment_area_text from public.imported_treatment_memories
        where import_batch_id = $1 and client_id = $2 order by source_row_number`,
      [batchId, clientId],
    );
    expect(mems.rowCount).toBe(2);
    expect(mems.rows.map((r) => r.treatment_area_text)).toEqual([
      "Upper lip",
      "Chin",
    ]);

    // Import must NOT create live charting or booking rows for the client.
    const sessions = await adminQuery(
      `select count(*)::int as n from public.sessions where client_id = $1`,
      [clientId],
    );
    const appts = await adminQuery(
      `select count(*)::int as n from public.appointments where client_id = $1`,
      [clientId],
    );
    expect(sessions.rows[0].n).toBe(0);
    expect(appts.rows[0].n).toBe(0);

    // The audit trigger recorded the batch + memory inserts (append-only,
    // written only by the SECURITY DEFINER trigger — the app writes none).
    const batchAudit = await adminQuery(
      `select count(*)::int as n from public.imported_treatment_memory_audit_events
        where record_type = 'import_batch' and record_id = $1 and action = 'created'`,
      [batchId],
    );
    expect(batchAudit.rows[0].n).toBe(1);
    const memAudit = await adminQuery(
      `select count(*)::int as n from public.imported_treatment_memory_audit_events
        where record_type = 'imported_treatment_memory' and action = 'created'
          and record_id in (
            select id from public.imported_treatment_memories where import_batch_id = $1
          )`,
      [batchId],
    );
    expect(memAudit.rows[0].n).toBe(2);
  });
});

describe("a non-owner cannot import (RLS owner-only writes)", () => {
  it("cannot insert an import_batch", async () => {
    await expect(
      userQuery(
        member.userId,
        `insert into public.import_batches (id, studio_id, source_type, created_by)
         values ($1, $2, 'spreadsheet', $3)`,
        [randomUUID(), s.studioId, member.userId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot insert an imported_treatment_memory", async () => {
    // Seed a batch + client via admin so only the memory INSERT is under test.
    const batchId = randomUUID();
    const clientId = randomUUID();
    await adminQuery(
      `insert into public.import_batches (id, studio_id, source_type) values ($1,$2,'other')`,
      [batchId, s.studioId],
    );
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,'Seeded')`,
      [clientId, s.studioId],
    );
    await expect(
      userQuery(
        member.userId,
        `insert into public.imported_treatment_memories
           (studio_id, client_id, import_batch_id, source_type, treatment_area_text)
         values ($1,$2,$3,'other','Neck')`,
        [s.studioId, clientId, batchId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
