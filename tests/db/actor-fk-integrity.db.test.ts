import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";

// 0179 — actor FK integrity, proved against a real local PostgreSQL.
//
// The static contract (which relationships 0179 may touch) is pinned in
// tests/migrations/0179-actor-fk-integrity.test.ts. This file proves the
// BEHAVIOUR that file cannot see: that a cross-studio actor is actually
// refused, that a non-actor relationship is actually unchanged, and that
// durable attribution actually survives a practitioner delete attempt.
//
// Fixtures are isolated by run-unique identity (seedStudio mints random UUIDs),
// never by cleanup, so this suite is safe to re-run against the same database.

afterAll(async () => {
  await closePool();
});

// A cross-studio write must fail with 23503 (foreign_key_violation). Returns
// the error code so a test can assert the REASON, not merely that it threw.
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? "UNKNOWN";
  }
}

describe("0179 — durable ACTOR attribution is same-studio", () => {
  it("rejects a cross-studio actor on clients.created_by", async () => {
    const a = await seedStudio("fk-clients-a");
    const b = await seedStudio("fk-clients-b");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.clients (id, studio_id, name, created_by) values ($1,$2,$3,$4)`,
        [randomUUID(), a.studioId, "cross-studio creator", b.practitionerId],
      ),
    );
    expect(code).toBe("23503");
  });

  it("accepts a same-studio actor on clients.created_by", async () => {
    const a = await seedStudio("fk-clients-ok");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.clients (id, studio_id, name, created_by) values ($1,$2,$3,$4)`,
        [randomUUID(), a.studioId, "same-studio creator", a.practitionerId],
      ),
    );
    expect(code).toBe("NO_ERROR");
  });

  it("still accepts a NULL actor — nullable truth is preserved", async () => {
    const a = await seedStudio("fk-clients-null");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.clients (id, studio_id, name, created_by) values ($1,$2,$3,null)`,
        [randomUUID(), a.studioId, "no creator"],
      ),
    );
    expect(code).toBe("NO_ERROR");
  });

  it("rejects a cross-studio author on client_clinical_notes.practitioner_id", async () => {
    const a = await seedStudio("fk-ccn-a");
    const b = await seedStudio("fk-ccn-b");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.client_clinical_notes
           (studio_id, client_id, practitioner_id, kind, body)
         values ($1,$2,$3,'consultation','cross-studio author')`,
        [a.studioId, a.clientId, b.practitionerId],
      ),
    );
    expect(code).toBe("23503");
  });

  it("rejects a cross-studio actor on the portal access log", async () => {
    // Named merely practitioner_id, but every non-null writer is the acting
    // practitioner, so 0179 treats it as an ACTOR column.
    const a = await seedStudio("fk-portal-a");
    const b = await seedStudio("fk-portal-b");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.client_portal_access_events
           (studio_id, client_id, practitioner_id, event_type)
         values ($1,$2,$3,'portal_link_sent')`,
        [a.studioId, a.clientId, b.practitionerId],
      ),
    );
    expect(code).toBe("23503");
  });
});

describe("0179 — durable actor attribution survives a practitioner delete", () => {
  it("RESTRICTs deleting a practitioner who authored a clinical note, and the note survives", async () => {
    // THE SECTION-3 CHANGE. Before 0179 this FK was ON DELETE CASCADE, so
    // deleting the practitioner would have DESTROYED their clinical notes —
    // contradicting the 0119 retention contract that historical attribution
    // survives account deletion.
    const a = await seedStudio("fk-del-a");
    const author = await seedMember(a, "fk-del-author");
    const noteId = randomUUID();
    await adminQuery(
      `insert into public.client_clinical_notes
         (id, studio_id, client_id, practitioner_id, kind, body)
       values ($1,$2,$3,$4,'consultation','durable clinical note')`,
      [noteId, a.studioId, a.clientId, author.practitionerId],
    );

    const code = await codeOf(() =>
      adminQuery(`delete from public.practitioners where id = $1`, [author.practitionerId]),
    );
    expect(code).toBe("23503");

    const rows = await adminQuery(
      `select practitioner_id from public.client_clinical_notes where id = $1`,
      [noteId],
    );
    expect(rows.rowCount).toBe(1);
    // Attribution intact — not nulled, not cascaded away.
    expect(rows.rows[0].practitioner_id).toBe(author.practitionerId);
  });

  it("NEGATIVE CONTROL: the same practitioner deletes once the actor row is gone", async () => {
    // Proves the RESTRICT above is caused by the actor row and not by some
    // unrelated reference the harness happens to create.
    const a = await seedStudio("fk-del-nc");
    const author = await seedMember(a, "fk-del-nc-author");
    const noteId = randomUUID();
    await adminQuery(
      `insert into public.client_clinical_notes
         (id, studio_id, client_id, practitioner_id, kind, body)
       values ($1,$2,$3,$4,'consultation','temporary note')`,
      [noteId, a.studioId, a.clientId, author.practitionerId],
    );
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.practitioners where id = $1`, [author.practitionerId]),
      ),
    ).toBe("23503");

    await adminQuery(`delete from public.client_clinical_notes where id = $1`, [noteId]);
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.practitioners where id = $1`, [author.practitionerId]),
      ),
    ).toBe("NO_ERROR");
  });
});

describe("0179 — NON-actor relationships are behaviourally unchanged", () => {
  it("record_keeping_disinfectants.operator_practitioner_id still accepts a cross-studio value", async () => {
    // DOMAIN SUBJECT, not the mutating actor: the operator is picked from a
    // dropdown (app/(app)/records/actions.ts), while created_by_practitioner_id
    // carries the actor. 0179 must not silently tighten it.
    const a = await seedStudio("fk-op-a");
    const b = await seedStudio("fk-op-b");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.record_keeping_disinfectants
           (studio_id, disinfectant_name, concentration, date_prepared, operator_name, operator_practitioner_id)
         values ($1,'proof','1:10',current_date,'proof',$2)`,
        [a.studioId, b.practitionerId],
      ),
    );
    expect(code).toBe("NO_ERROR");
  });

  it("sessions.practitioner_id (ASSIGNEE) still accepts a cross-studio value", async () => {
    const a = await seedStudio("fk-sess-a");
    const b = await seedStudio("fk-sess-b");
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at)
         values ($1,$2,$3,'electrolysis',now())`,
        [a.studioId, a.clientId, b.practitionerId],
      ),
    );
    expect(code).toBe("NO_ERROR");
  });

  it("electrolysis_entries.deleted_by (Class C) is untouched — no local studio lineage", async () => {
    const a = await seedStudio("fk-elec-a");
    const b = await seedStudio("fk-elec-b");
    const s = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at)
       values ($1,$2,$3,'electrolysis',now()) returning id`,
      [a.studioId, a.clientId, a.practitionerId],
    );
    const code = await codeOf(() =>
      adminQuery(
        `insert into public.electrolysis_entries
           (session_id, area, pulse_count, observation_chips, deleted_by)
         values ($1,'chin',1,'[]'::jsonb,$2)`,
        [s.rows[0].id, b.practitionerId],
      ),
    );
    // Accepted precisely because the table carries no studio_id to check
    // against. This is the recorded residual limitation, asserted so that
    // closing it later is a deliberate change and not a silent one.
    expect(code).toBe("NO_ERROR");
  });
});

describe("0179 — catalog shape", () => {
  it("leaves exactly the expected nine simple practitioner FKs", async () => {
    const res = await adminQuery(`
      select ct.relname || '.' ||
             (select a.attname from pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) as ref
      from pg_constraint con
      join pg_class ct on ct.oid = con.conrelid
      join pg_class pt on pt.oid = con.confrelid
      join pg_namespace pn on pn.oid = pt.relnamespace
      where con.contype = 'f' and pt.relname = 'practitioners' and pn.nspname = 'public'
        and array_length(con.conkey, 1) = 1
      order by 1`);
    // Every remaining simple FK is out of 0179's actor scope by an explicit
    // ruling: assignee, resource, recipient, domain subject, clinical performer
    // provenance, or a parent-scoped actor with no local studio lineage.
    expect(res.rows.map((r: { ref: string }) => r.ref)).toEqual([
      "electrolysis_entries.deleted_by",
      "laser_entries.deleted_by",
      "practitioner_notifications.practitioner_id",
      "record_keeping_disinfectants.operator_practitioner_id",
      "session_audit.edited_by_practitioner_id",
      "sessions.aftercare_and_risks_explained_by",
      "sessions.performed_by_practitioner_id",
      "sessions.practitioner_id",
      "studio_calendar_reservations.practitioner_id",
    ]);
  });

  it("no practitioner FK anywhere is ON DELETE CASCADE onto durable clinical evidence", async () => {
    const res = await adminQuery(`
      select ct.relname as tbl
      from pg_constraint con
      join pg_class ct on ct.oid = con.conrelid
      join pg_class pt on pt.oid = con.confrelid
      join pg_namespace pn on pn.oid = pt.relnamespace
      where con.contype = 'f' and pt.relname = 'practitioners' and pn.nspname = 'public'
        and con.confdeltype = 'c'
      order by 1`);
    const cascading = res.rows.map((r: { tbl: string }) => r.tbl);
    expect(cascading).not.toContain("client_clinical_notes");
    // The CASCADEs that remain are all tenant-scoped configuration or
    // practitioner-owned resources, never clinical or audit evidence.
    for (const t of cascading) {
      expect([
        "calendar_connections",
        "google_oauth_states",
        "service_practitioners",
        "studio_availability_default",
        "studio_availability_overrides",
        "studio_calendar_reservations",
      ]).toContain(t);
    }
  });

  it("auth.users provenance is untouched — still four columns, still auth.users", async () => {
    const res = await adminQuery(`
      select ct.relname || '.' ||
             (select a.attname from pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) as ref
      from pg_constraint con
      join pg_class ct on ct.oid = con.conrelid
      join pg_class pt on pt.oid = con.confrelid
      join pg_namespace pn on pn.oid = pt.relnamespace
      where con.contype = 'f' and pt.relname = 'users' and pn.nspname = 'auth'
        and ct.relname in ('import_batches','imported_treatment_memories')
      order by 1`);
    expect(res.rows.map((r: { ref: string }) => r.ref)).toEqual([
      "import_batches.created_by",
      "import_batches.voided_by",
      "imported_treatment_memories.imported_by",
      "imported_treatment_memories.voided_by",
    ]);
  });

  it("the 0178 practitioner identity boundary is still SELECT-only for every runtime role", async () => {
    const res = await adminQuery(`
      select r.rolname,
             has_table_privilege(r.rolname,'public.practitioners','SELECT')   as sel,
             has_table_privilege(r.rolname,'public.practitioners','INSERT')   as ins,
             has_table_privilege(r.rolname,'public.practitioners','UPDATE')   as upd,
             has_table_privilege(r.rolname,'public.practitioners','DELETE')   as del,
             has_table_privilege(r.rolname,'public.practitioners','MAINTAIN') as maint,
             has_any_column_privilege(r.rolname,'public.practitioners','UPDATE') as anycol
      from (values ('anon'),('authenticated'),('service_role')) r(rolname)`);
    for (const row of res.rows) {
      expect(row.sel).toBe(true);
      expect(row.ins).toBe(false);
      expect(row.upd).toBe(false);
      expect(row.del).toBe(false);
      expect(row.maint).toBe(false);
      expect(row.anycol).toBe(false);
    }
  });
});
