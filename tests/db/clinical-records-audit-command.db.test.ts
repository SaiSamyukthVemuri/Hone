import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

// 0233 (HON-46, Codex P1 4304545551): the clinical-records audit is
// ACTOR-BOUND. A studio member can no longer write clinical_records_* rows
// directly, nor any audit row naming another practitioner as actor; the ONE
// way in is record_clinical_records_audit, which records auth.uid()'s own
// owner row. The two remaining member-path writers (client archive/unarchive,
// studio data export) still work: they name their own actor.

afterAll(() => closePool());

const meta = { scope: "day", day: "2026-09-15" };
const refused = (e: unknown) => (e as { code?: string }).code;

async function rowsFor(clientId: string) {
  return (
    await adminQuery(`select action, actor_id, studio_id from public.audit_logs where entity_id = $1 order by created_at`, [
      clientId,
    ])
  ).rows;
}

describe("0233: clinical-records audit rows are actor-bound", () => {
  it("a member's FORGED direct insert is refused: a clinical_records_* action, or another actor's id", async () => {
    const s = await seedStudio("aud0233a");
    const member = await seedMember(s, "aud0233a-m");

    // A non-owner member forging an owner's PRINT through PostgREST-style SQL.
    await expect(
      asUser(member.userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'clinical_records_printed', 'client', $3, $4)`,
          [s.studioId, s.practitionerId, s.clientId, meta],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    // Even naming THEMSELVES, a member cannot write a clinical_records_* row.
    await expect(
      asUser(member.userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'clinical_records_previewed', 'client', $3, $4)`,
          [s.studioId, member.practitionerId, s.clientId, meta],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    // The OWNER cannot write one directly either: only through the command.
    await expect(
      asUser(s.userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'clinical_records_printed', 'client', $3, $4)`,
          [s.studioId, s.practitionerId, s.clientId, meta],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    // A member naming ANOTHER (non-owner) member as actor, on a print: refused.
    const member2 = await seedMember(s, "aud0233a-m2");
    await expect(
      asUser(member.userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'clinical_records_printed', 'client', $3, $4)`,
          [s.studioId, member2.practitionerId, s.clientId, meta],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    // anon cannot insert at all.
    await expect(
      asRole("anon", (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'clinical_records_printed', 'client', $3, $4)`,
          [s.studioId, s.practitionerId, s.clientId, meta],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    // Any other action naming ANOTHER practitioner as actor is refused too.
    await expect(
      asUser(member.userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, 'client_archived', 'client', $3, '{}'::jsonb)`,
          [s.studioId, s.practitionerId, s.clientId],
        ),
      ),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
    expect(await rowsFor(s.clientId)).toEqual([]);
  });

  it("the remaining member-path writers still work: own actor, ordinary actions", async () => {
    const s = await seedStudio("aud0233b");
    const member = await seedMember(s, "aud0233b-m");
    // app/(app)/clients/[id]/actions.ts (archive/unarchive) and
    // app/(app)/settings/data/actions.ts (studio_export): actor = self.
    for (const [userId, actorId, action] of [
      [s.userId, s.practitionerId, "client_archived"],
      [member.userId, member.practitionerId, "client_unarchived"],
      [s.userId, s.practitionerId, "studio_export"],
    ] as const) {
      await asUser(userId, (q) =>
        q(
          `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
           values ($1, $2, $3, 'client', $4, '{}'::jsonb)`,
          [s.studioId, actorId, action, s.clientId],
        ),
      );
    }
    expect((await rowsFor(s.clientId)).map((r) => r.action)).toEqual([
      "client_archived",
      "client_unarchived",
      "studio_export",
    ]);
  });

  it("the service-role sms_opt_out writer (Twilio inbound, actor null) is unaffected", async () => {
    const s = await seedStudio("aud0233e");
    // app/api/twilio/inbound-sms/route.ts writes through createAdminClient.
    // asRole runs in a rolled-back transaction, so the row is read back inside it.
    const n = await asRole("service_role", async (q) => {
      await q(
        `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
         values ($1, null, 'sms_opt_out', 'client', $2, '{"source":"twilio_stop"}'::jsonb)`,
        [s.studioId, s.clientId],
      );
      return (await q(`select count(*)::int as n from public.audit_logs where entity_id = $1 and action = 'sms_opt_out'`, [s.clientId]))
        .rows[0].n as number;
    });
    expect(n).toBe(1);
  });

  it("the command records auth.uid()'s own owner row, the client's studio, and the bound id", async () => {
    const s = await seedStudio("aud0233c");
    const id = randomUUID();
    const r = await asUser(s.userId, (q) =>
      q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2, $3) as id`, [
        s.clientId,
        meta,
        id,
      ]),
    );
    expect(r.rows[0].id).toBe(id);
    const rows = await adminQuery(`select studio_id, actor_id, action, entity_id, metadata from public.audit_logs where id = $1`, [id]);
    expect(rows.rows[0]).toMatchObject({
      studio_id: s.studioId,
      actor_id: s.practitionerId,
      action: "clinical_records_previewed",
      entity_id: s.clientId,
      metadata: meta,
    });
  });

  it("the command refuses a non-owner, another studio's client, a bad action and unlisted metadata", async () => {
    const s = await seedStudio("aud0233d");
    const other = await seedStudio("aud0233d-o");
    const member = await seedMember(s, "aud0233d-m");
    const call = (userId: string, clientId: string, action: string, m: unknown) =>
      asUser(userId, (q) => q(`select public.record_clinical_records_audit($1, $2, $3)`, [clientId, action, m]));

    await expect(call(member.userId, s.clientId, "clinical_records_printed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    // Cross-studio, both directions: studio A's owner with studio B's client,
    // and studio B's owner with studio A's client.
    await expect(call(s.userId, other.clientId, "clinical_records_printed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    await expect(call(other.userId, s.clientId, "clinical_records_previewed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    await expect(call(s.userId, s.clientId, "client_archived", meta)).rejects.toSatisfy((e) => refused(e) === "22023");
    await expect(
      call(s.userId, s.clientId, "clinical_records_printed", { ...meta, client_name: "Jane" }),
    ).rejects.toSatisfy((e) => refused(e) === "22023");
    expect(await rowsFor(s.clientId)).toEqual([]);
    expect(await rowsFor(other.clientId)).toEqual([]);
  });

  it("EXECUTE: authenticated only; revoked from anon and service_role by name", async () => {
    for (const fn of [
      "public.record_clinical_records_audit(uuid, text, jsonb, uuid)",
      "public.audit_actor_is_caller(uuid, uuid)",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('authenticated', $1, 'execute') as authn,
                has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [fn],
      );
      expect(r.rows[0], fn).toEqual({ authn: true, anon: false, svc: false });
    }
    await expect(
      asRole("anon", (q) => q(`select public.record_clinical_records_audit($1, 'clinical_records_printed', $2)`, [randomUUID(), meta])),
    ).rejects.toSatisfy((e) => refused(e) === "42501");
  });
});
