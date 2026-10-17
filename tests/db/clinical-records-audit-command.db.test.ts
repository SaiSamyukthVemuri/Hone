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

    // (Authorization is shown with well-formed PREVIEW payloads, so the
    // refusal is the caller's role or studio, never the metadata shape.)
    await expect(call(member.userId, s.clientId, "clinical_records_previewed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    // Cross-studio, both directions: studio A's owner with studio B's client,
    // and studio B's owner with studio A's client.
    await expect(call(s.userId, other.clientId, "clinical_records_previewed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    await expect(call(other.userId, s.clientId, "clinical_records_previewed", meta)).rejects.toSatisfy(
      (e) => refused(e) === "42501",
    );
    await expect(call(s.userId, s.clientId, "client_archived", meta)).rejects.toSatisfy((e) => refused(e) === "22023");
    await expect(
      call(s.userId, s.clientId, "clinical_records_previewed", { ...meta, client_name: "Jane" }),
    ).rejects.toSatisfy((e) => refused(e) === "22023");
    expect(await rowsFor(s.clientId)).toEqual([]);
    expect(await rowsFor(other.clientId)).toEqual([]);
  });

  it("value SHAPES and the scope's KEY SET are enforced, each refused 22023 (HIPAA review F2)", async () => {
    const s = await seedStudio("aud0233f");
    const call = (m: unknown) =>
      asUser(s.userId, (q) => q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2)`, [s.clientId, m]));
    for (const [why, m] of [
      ["day not YYYY-MM-DD", { scope: "day", day: "15/09/2026" }],
      // N2: the right shape, but not a calendar date.
      ["day 2026-99-99 (shape only)", { scope: "day", day: "2026-99-99" }],
      ["day 2026-02-30 (no such day)", { scope: "day", day: "2026-02-30" }],
      ["range to 2026-13-01 (no such month)", { scope: "range", from: "2026-09-01", to: "2026-13-01" }],
      ["from not YYYY-MM-DD", { scope: "range", from: "2026-9-1", to: "2026-09-30" }],
      ["to carries free text", { scope: "range", from: "2026-09-01", to: "Jane Doe" }],
      ["session_id not a UUID", { scope: "session", session_id: "not-a-uuid" }],
      ["day scope missing day", { scope: "day" }],
      ["day scope with from/to", { scope: "day", day: "2026-09-15", from: "2026-09-01" }],
      ["range scope missing to", { scope: "range", from: "2026-09-01" }],
      ["range scope with day", { scope: "range", from: "2026-09-01", to: "2026-09-30", day: "2026-09-15" }],
      ["session scope missing session_id", { scope: "session" }],
      ["session scope with a day", { scope: "session", session_id: randomUUID(), day: "2026-09-15" }],
    ] as const) {
      await expect(call(m), why).rejects.toSatisfy((e) => refused(e) === "22023");
    }
    // The well-formed shape of each scope is accepted.
    for (const m of [
      { scope: "day", day: "2026-09-15" },
      { scope: "range", from: "2026-09-01", to: "2026-09-30" },
      { scope: "session", session_id: randomUUID() },
    ]) {
      await asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2)`, [s.clientId, m]),
      );
    }
    expect((await rowsFor(s.clientId)).length).toBe(3);
  });

  it("a PRINT must cite this owner's own preview of this client (HIPAA review F3)", async () => {
    const s = await seedStudio("aud0233g");
    const other = await seedStudio("aud0233g-o");
    const secondClient = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Second') returning id`, [
      s.studioId,
    ]);
    const secondClientId = secondClient.rows[0].id as string;
    const preview = (userId: string, clientId: string) =>
      asUser(userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2) as id`, [clientId, meta]),
      ).then((r) => r.rows[0].id as string);
    const print = (userId: string, clientId: string, previewId: string | null) =>
      asUser(userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_printed', $2) as id`, [
          clientId,
          previewId === null ? meta : { ...meta, preview_audit_id: previewId },
        ]),
      );

    const ownPreview = await preview(s.userId, s.clientId);
    const otherClientPreview = await preview(s.userId, secondClientId);
    const otherActorPreview = await preview(other.userId, other.clientId);

    // Refused: no preview cited; another client's preview; another owner's
    // preview; an id that names no row.
    for (const [why, previewId] of [
      ["no preview cited", null],
      ["another client's preview", otherClientPreview],
      ["another actor's (another studio's owner) preview", otherActorPreview],
      ["a nonexistent preview id", randomUUID()],
    ] as const) {
      await expect(print(s.userId, s.clientId, previewId), why).rejects.toSatisfy((e) => refused(e) === "22023");
    }
    // N1: the cited preview must be of the SAME scope as the print...
    await expect(
      asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_printed', $2)`, [
          s.clientId,
          { scope: "day", day: "2026-09-16", preview_audit_id: ownPreview },
        ]),
      ),
      "a print of a different day than the cited preview",
    ).rejects.toSatisfy((e) => refused(e) === "22023");
    // ...and RECENT: within the print token's 30 minutes.
    const stalePreview = await preview(s.userId, s.clientId);
    await adminQuery(`update public.audit_logs set created_at = now() - interval '31 minutes' where id = $1`, [stalePreview]);
    await expect(print(s.userId, s.clientId, stalePreview), "a preview older than 30 minutes").rejects.toSatisfy(
      (e) => refused(e) === "22023",
    );
    // A print row cannot be cited as a preview either; the honest print is accepted.
    const ok = await print(s.userId, s.clientId, ownPreview);
    await expect(print(s.userId, s.clientId, ok.rows[0].id as string)).rejects.toSatisfy((e) => refused(e) === "22023");
    // Exactly: the owner's preview, then the one honest print.
    expect((await rowsFor(s.clientId)).map((r) => r.action)).toEqual([
      "clinical_records_previewed",
      "clinical_records_previewed",
      "clinical_records_printed",
    ]);
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
