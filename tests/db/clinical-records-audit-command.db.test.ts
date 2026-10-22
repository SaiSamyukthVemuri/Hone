import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { adminQuery, adminTx, asRole, asUser, closePool, type UserQuery, seedMember, seedSession, seedStudio } from "./helpers/harness";
import { countVersion } from "../migrations/helpers/migration-state";

// 0233 (HON-46, Codex P1 4304545551): the clinical-records audit is
// ACTOR-BOUND. A studio member can no longer write clinical_records_* rows
// directly, nor any audit row naming another practitioner as actor; the ONE
// way in is record_clinical_records_audit, which records auth.uid()'s own
// owner row.0242 closes all direct member generic inserts; archive/unarchive
// and owner export now use narrow trusted server writers with derived actors.

afterAll(() => closePool());

const meta = { scope: "day", day: "2026-09-15" };
const refused = (e: unknown) => (e as { code?: string }).code;

// CANDIDATE-COMPOSITION cases need a command a LATER migration adds. They RUN
// on a chain that has it (the composed candidate, 0213-0233) and SKIP, by
// name, on one that does not (#896 alone). Detected from the live catalog,
// never assumed from a file list.
async function hasFunction(name: string): Promise<boolean> {
  const r = await adminQuery(
    `select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = $1) as ok`,
    [name],
  );
  return r.rows[0].ok === true;
}
const HAS_RECEPTIONISTS = await hasFunction("add_studio_receptionist"); // 0216

async function rowsFor(clientId: string) {
  return (
    await adminQuery(`select action, actor_id, studio_id from public.audit_logs where entity_id = $1 order by created_at`, [
      clientId,
    ])
  ).rows;
}

describe("0233: a print's scope must EQUAL its preview's, compared NORMALIZED (Codex P1 4304947291)", () => {
  it("mismatched scopes are refused; an equivalent scope (key order, id case) is accepted", async () => {
    const s = await seedStudio("aud0233n");
    // Real sessions of THIS client: a session scope must name one (Codex P1 4305625192).
    const SESSION = (await seedSession(s)).sessionId;
    const SECOND_SESSION = (await seedSession(s)).sessionId;
    const preview = (m: unknown) =>
      asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2) as id`, [s.clientId, m]),
      ).then((r) => r.rows[0].id as string);
    const print = (m: unknown) =>
      asUser(s.userId, (q) => q(`select public.record_clinical_records_audit($1, 'clinical_records_printed', $2) as id`, [s.clientId, m]));

    const dayPreview = await preview({ scope: "day", day: "2026-09-15" });
    const rangePreview = await preview({ scope: "range", from: "2026-09-01", to: "2026-09-30" });
    const sessionPreview = await preview({ scope: "session", session_id: SESSION });

    // REFUSED: day vs range, a different day, a different range, a different session.
    for (const [why, m] of [
      ["day print citing a range preview", { scope: "day", day: "2026-09-15", preview_audit_id: rangePreview }],
      ["range print citing a day preview", { scope: "range", from: "2026-09-15", to: "2026-09-15", preview_audit_id: dayPreview }],
      ["a different day", { scope: "day", day: "2026-09-16", preview_audit_id: dayPreview }],
      ["a different range", { scope: "range", from: "2026-09-01", to: "2026-09-29", preview_audit_id: rangePreview }],
      ["a different session", { scope: "session", session_id: SECOND_SESSION, preview_audit_id: sessionPreview }],
    ] as const) {
      await expect(print(m), why).rejects.toSatisfy((e) => refused(e) === "22023");
    }

    // ACCEPTED: the same scope in an equivalent form.
    //   * keys in a different order (jsonb equality is order-insensitive);
    //   * the session id and the cited preview id in UPPER case (normalized).
    await print({ preview_audit_id: dayPreview, day: "2026-09-15", scope: "day" });
    await print({ to: "2026-09-30", preview_audit_id: rangePreview.toUpperCase(), from: "2026-09-01", scope: "range" });
    await print({ scope: "session", session_id: SESSION.toUpperCase(), preview_audit_id: sessionPreview.toUpperCase() });

    // What was STORED is the normalized form, so later comparisons are like for like.
    const printed = await adminQuery(
      `select metadata from public.audit_logs where entity_id = $1 and action = 'clinical_records_printed' order by created_at`,
      [s.clientId],
    );
    expect(printed.rows.map((r) => r.metadata)).toEqual([
      { scope: "day", day: "2026-09-15", preview_audit_id: dayPreview },
      { scope: "range", from: "2026-09-01", to: "2026-09-30", preview_audit_id: rangePreview },
      { scope: "session", session_id: SESSION, preview_audit_id: sessionPreview },
    ]);
  });
});

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

  it("0242 closes ordinary generic inserts even with the caller's own actor", async () => {
    const s = await seedStudio("aud0242b");
    const member = await seedMember(s, "aud0242b-m");
    for (const [userId, actorId, action] of [
      [s.userId, s.practitionerId, "client_archived"],
      [member.userId, member.practitionerId, "client_unarchived"],
      [s.userId, s.practitionerId, "studio_export"],
    ] as const) {
      await expect(asUser(userId, (q) => q(
        `insert into public.audit_logs (studio_id,actor_id,action,entity_type,entity_id,metadata)
         values ($1,$2,$3,'client',$4,'{"forged":"contents"}'::jsonb)`,
        [s.studioId, actorId, action, s.clientId],
      ))).rejects.toSatisfy((e) => refused(e) === "42501");
    }
    expect(await rowsFor(s.clientId)).toEqual([]);
  });

  it("0242 denies table and column INSERT privileges but preserves existing service authority", async () => {
    const r = await adminQuery(`select
      has_table_privilege('anon','public.audit_logs','INSERT') as anon_insert,
      has_any_column_privilege('anon','public.audit_logs','INSERT') as anon_column,
      has_table_privilege('authenticated','public.audit_logs','INSERT') as auth_insert,
      has_any_column_privilege('authenticated','public.audit_logs','INSERT') as auth_column,
      has_table_privilege('service_role','public.audit_logs','INSERT') as trusted_insert`);
    expect(r.rows[0]).toEqual({ anon_insert: false, anon_column: false, auth_insert: false, auth_column: false, trusted_insert: true });
    const policies = await adminQuery("select polname from pg_policy where polrelid='public.audit_logs'::regclass");
    expect(policies.rows.map((p) => p.polname)).not.toContain("audit_logs: members insert");
    expect(policies.rows.map((p) => p.polname)).toContain("audit_logs: members read");
  });

  it("0242 blocks anonymous/no-identity inserts and preserves scoped reads/no update-delete", async () => {
    const s = await seedStudio("aud0242r");
    const other = await seedStudio("aud0242other");
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (q) => q("insert into public.audit_logs(studio_id,action) values($1,'forged')", [s.studioId]))).rejects.toSatisfy((e) => refused(e) === "42501");
    }
    const inserted = await adminQuery(`insert into public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
      values($1,$2,'client_archived','client',$3,'{}') returning id`, [s.studioId, s.practitionerId, s.clientId]);
    const id = inserted.rows[0].id;
    expect((await asUser(s.userId, (q) => q("select id from public.audit_logs where id=$1", [id]))).rows).toHaveLength(1);
    expect((await asUser(other.userId, (q) => q("select id from public.audit_logs where id=$1", [id]))).rows).toHaveLength(0);
    for (const sql of ["update public.audit_logs set metadata='{\"forged\":true}' where id=$1 returning id", "delete from public.audit_logs where id=$1 returning id"]) {
      try { expect((await asUser(s.userId, (q) => q(sql, [id]))).rows).toHaveLength(0); }
      catch (e) { expect(refused(e)).toBe("42501"); }
    }
    expect((await adminQuery("select id,metadata from public.audit_logs where id=$1", [id])).rows).toEqual([{ id, metadata: {} }]);
  });

  it("0242 inactive identity cannot create a generic event or read another studio", async () => {
    const s = await seedStudio("aud0242inactive");
    await adminQuery("update public.practitioners set active=false where id=$1", [s.practitionerId]);
    await expect(asUser(s.userId, (q) => q("insert into public.audit_logs(studio_id,actor_id,action) values($1,$2,'client_archived')", [s.studioId, s.practitionerId]))).rejects.toSatisfy((e) => refused(e) === "42501");
    expect(await rowsFor(s.clientId)).toEqual([]);
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
      { scope: "session", session_id: (await seedSession(s)).sessionId },
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

  it("a RANGE is ordered and spans at most 366 days (Codex P2 4305625196)", async () => {
    const s = await seedStudio("aud0233r");
    const call = (from: string, to: string) =>
      asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2)`, [
          s.clientId,
          { scope: "range", from, to },
        ]),
      );
    // Refused: reversed, and one day over the page's MAX_RANGE_DAYS (366).
    await expect(call("2026-09-30", "2026-09-01"), "from after to").rejects.toSatisfy((e) => refused(e) === "22023");
    await expect(call("2026-01-01", "2027-01-02"), "367 days inclusive").rejects.toSatisfy((e) => refused(e) === "22023");
    // Accepted: a single day (from = to) and exactly 366 days inclusive.
    await call("2026-09-15", "2026-09-15");
    await call("2026-01-01", "2027-01-01");
    expect((await rowsFor(s.clientId)).length).toBe(2);
  });

  it("rejects deleted session previews and prints, including deletion after preview (4309703170)", async () => {
    const s = await seedStudio("aud0233deleted");
    const sessionId = (await seedSession(s)).sessionId;
    const scope = { scope: "session", session_id: sessionId };
    const call = (action: string, metadata: unknown) =>
      asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, $2, $3) as id`, [s.clientId, action, metadata]),
      );
    // Positive control: the same live session supports preview and print.
    const preview = await call("clinical_records_previewed", scope);
    const printScope = { ...scope, preview_audit_id: preview.rows[0].id };
    await call("clinical_records_printed", printScope);
    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [sessionId]);
    const before = await rowsFor(s.clientId);
    expect(before.map((r) => r.action).sort()).toEqual(["clinical_records_previewed", "clinical_records_printed"]);
    await expect(call("clinical_records_previewed", scope)).rejects.toSatisfy((e) => refused(e) === "22023");
    // A still-recent, genuine preview must not authorize printing a deleted session.
    await expect(call("clinical_records_printed", printScope)).rejects.toSatisfy((e) => refused(e) === "22023");
    expect(await rowsFor(s.clientId)).toEqual(before);
  });

  it("a SESSION scope must name this client's own session (Codex P1 4305625192)", async () => {
    const s = await seedStudio("aud0233s");
    const other = await seedStudio("aud0233s-o");
    const second = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Second') returning id`, [
      s.studioId,
    ]);
    const secondClientId = second.rows[0].id as string;
    const own = (await seedSession(s)).sessionId;
    // Another client's session in the SAME studio, and another studio's session.
    const sameStudioOtherClient = (await seedSession({ ...s, clientId: secondClientId })).sessionId;
    const otherStudio = (await seedSession(other)).sessionId;
    const call = (action: string, m: unknown) =>
      asUser(s.userId, (q) =>
        q(`select public.record_clinical_records_audit($1, $2, $3) as id`, [s.clientId, action, m]),
      );

    // PREVIEW: refused for another client's session, another studio's
    // session, and an id that names no session.
    for (const [why, sessionId] of [
      ["another client's session, same studio", sameStudioOtherClient],
      ["another studio's session", otherStudio],
      ["a nonexistent session", randomUUID()],
    ] as const) {
      await expect(call("clinical_records_previewed", { scope: "session", session_id: sessionId }), why).rejects.toSatisfy(
        (e) => refused(e) === "22023",
      );
    }

    // PRINT, end to end through the print path: a preview row of THIS client
    // scoped to ANOTHER client's session cannot be made through the command,
    // so it is forged directly (as the database owner, bypassing the command).
    // A print citing it, with the scope copied exactly, is still refused.
    const forged = await adminQuery(
      `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
       values ($1, $2, 'clinical_records_previewed', 'client', $3, $4) returning id`,
      [s.studioId, s.practitionerId, s.clientId, { scope: "session", session_id: sameStudioOtherClient }],
    );
    const forgedId = forged.rows[0].id as string;
    await expect(
      call("clinical_records_printed", { scope: "session", session_id: sameStudioOtherClient, preview_audit_id: forgedId }),
      "a print citing a preview of another client's session",
    ).rejects.toSatisfy((e) => refused(e) === "22023");

    // The honest session preview and its print are accepted.
    const ok = await call("clinical_records_previewed", { scope: "session", session_id: own });
    await call("clinical_records_printed", { scope: "session", session_id: own, preview_audit_id: ok.rows[0].id });
    // The forged row, then the honest preview and print: no refused call wrote anything.
    expect((await rowsFor(s.clientId)).map((r) => r.action)).toEqual([
      "clinical_records_previewed",
      "clinical_records_previewed",
      "clinical_records_printed",
    ]);
    expect(await rowsFor(other.clientId)).toEqual([]);
  });

  // NOT GREEN-BY-SKIP: on a tree that CARRIES 0216 the gate must be open, so
  // the receptionist case below can only skip where 0216 truly is absent.
  it("the receptionist gate is open wherever the tree carries 0216", () => {
    if (countVersion("0216") > 0) expect(HAS_RECEPTIONISTS, "0216 is in the tree but add_studio_receptionist is not in the catalog").toBe(true);
  });

  it.runIf(HAS_RECEPTIONISTS)("a 0216 RECEPTIONIST is refused the command and cannot write an audit row (candidate composition; skips without add_studio_receptionist from 0216)", async () => {
    const s = await seedStudio("aud0233rc");
    // Through the real authority command (0216), with a real auth user.
    const userId = randomUUID();
    const email = `aud0233rc-${userId.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    const added = await adminQuery(`select public.add_studio_receptionist($1, $2, $3, $4, $5) as id`, [
      s.studioId,
      s.practitionerId,
      userId,
      "Front desk",
      email,
    ]);
    expect(added.rows[0].id).toBeTruthy();
    // The command: the actor must be the studio's active OWNER practitioner.
    for (const m of [meta, { scope: "session", session_id: (await seedSession(s)).sessionId }]) {
      await expect(
        asUser(userId, (q) => q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2)`, [s.clientId, m])),
      ).rejects.toSatisfy((e) => refused(e) === "42501");
    }
    // The narrowed member-insert path: neither a clinical_records_* row nor an
    // ordinary row naming the owner as actor.
    for (const action of ["clinical_records_previewed", "client_archived"]) {
      await expect(
        asUser(userId, (q) =>
          q(
            `insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
             values ($1, $2, $3, 'client', $4, '{}'::jsonb)`,
            [s.studioId, s.practitionerId, action, s.clientId],
          ),
        ),
      ).rejects.toBeTruthy();
    }
    expect(await rowsFor(s.clientId)).toEqual([]);
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


// Prepared atomic-command cases; execution requires the aligned CI/DB gate.
describe("0242 atomic governed audit authorization", () => {
  // Unlike asRole's deliberately rolled-back privilege probes, these
  // command transactions commit so cross-connection audit assertions are real.
  const serviceCommand = <T>(run: (q: UserQuery) => Promise<T>) => adminTx(async q => {
    await q("set local role service_role");
    return run(q);
  });
  async function exportArgs(s: Awaited<ReturnType<typeof seedStudio>>) {
    const { rows: [studio] } = await adminQuery("select name from public.studios where id=$1", [s.studioId]);
    const slug = String(studio.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "studio";
    return [s.practitionerId, s.userId, s.studioId,
      `hone-export-${slug}-2026-10-21.zip`, ["clients.csv", "manifest.json", "README.txt"], { clients: 0 }];
  }
  const exportSQL = "select public.record_studio_export_audit_governed($1,$2,$3,$4,$5,$6) as recorded";
  it("retains exact active owner emission and fixed archive/unarchive rows", async () => {
    const s = await seedStudio("aud0242-atomic-ok");
    const args = await exportArgs(s);
    expect((await serviceCommand(q => q(exportSQL, args))).rows[0].recorded).toBe(true);
    for (const archived of [true, false]) {
      const reply = await serviceCommand(q => q(
        "select public.record_client_archive_audit_governed($1,$2,$3,$4,$5,$6) as recorded",
        [s.practitionerId,s.userId,s.studioId,s.clientId,archived,archived ? "2026-10-21T01:00:00.000Z" : null]));
      expect(reply.rows[0].recorded).toBe(true);
    }
    expect((await rowsFor(s.clientId)).map(row => row.action)).toEqual(["client_archived","client_unarchived"]);
  });
  it.each(["inactive", "demoted"] as const)("committed %s before atomic owner check refuses without an audit", async change => {
    const s = await seedStudio(`aud0242-${change}`);
    const args = await exportArgs(s);
    await adminQuery(change === "inactive"
      ? "update public.practitioners set active=false where id=$1"
      : "update public.practitioners set role='practitioner' where id=$1", [s.practitionerId]);
    expect((await serviceCommand(q => q(exportSQL,args))).rows[0].recorded).toBe(false);
    expect(await rowsFor(s.studioId)).toEqual([]);
  });
  it("concurrent deactivation waits for authorized audit commit (no post-commit revocation claim)", async () => {
    const s = await seedStudio("aud0242-lock");
    const args = await exportArgs(s);
    let worker: Promise<unknown> | undefined;
    let workerPid!: number;
    let announce!: () => void;
    const announced = new Promise<void>(resolve => { announce = resolve; });
    await adminTx(async q => {
      await q("set local role service_role");
      expect((await q(exportSQL,args)).rows[0].recorded).toBe(true);
      worker = adminTx(async other => {
        const { rows: [backend] } = await other("select pg_backend_pid() as pid");
        workerPid = backend.pid; announce();
        await other("set local lock_timeout='2s'");
        await other("update public.practitioners set active=false where id=$1", [s.practitionerId]);
      });
      void worker.catch(() => undefined);
      await announced;
      let waiting = false;
      for (let i=0;i<50;i++) {
        const { rows: [backend] } = await adminQuery("select wait_event_type from pg_stat_activity where pid=$1", [workerPid]);
        if (backend?.wait_event_type === "Lock") { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      expect(await rowsFor(s.studioId)).toEqual([]); // Uncommitted audit not externally visible.
    });
    await worker;
    expect(await rowsFor(s.studioId)).toHaveLength(1);
    const { rows: [member] } = await adminQuery("select active from public.practitioners where id=$1", [s.practitionerId]);
    expect(member.active).toBe(false);
  });
  it.each(["inactive", "demoted"] as const)("a concurrent %s change committed before the membership lock refuses emission", async change => {
    const s = await seedStudio(`aud0242-revoke-first-${change}`);
    const args = await exportArgs(s);
    let command: Promise<{ rows: Array<{ recorded: boolean }> }> | undefined;
    let workerPid!: number;
    let announce!: () => void;
    const announced = new Promise<void>(resolve => { announce = resolve; });
    try {
      await adminTx(async q => {
        await q(change === "inactive"
          ? "update public.practitioners set active=false where id=$1"
          : "update public.practitioners set role='practitioner' where id=$1", [s.practitionerId]);
        command = serviceCommand(async worker => {
          const { rows: [backend] } = await worker("select pg_backend_pid() as pid");
          workerPid = backend.pid; announce();
          return worker(exportSQL,args);
        });
        void command.catch(() => undefined);
        await announced;
        let waiting = false;
        for (let i=0;i<50;i++) {
          const { rows: [backend] } = await adminQuery("select wait_event_type from pg_stat_activity where pid=$1", [workerPid]);
          if (backend?.wait_event_type === "Lock") { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve,10));
        }
        expect(waiting).toBe(true);
        expect(await rowsFor(s.studioId)).toEqual([]);
      });
      expect((await command)!.rows[0].recorded).toBe(false);
      expect(await rowsFor(s.studioId)).toEqual([]);
    } finally {
      // Drain even a failed assertion's worker after the revoker rolls back.
      await command?.catch(() => undefined);
    }
  });

  it("exposes only the two narrow non-grantable service EXECUTE capabilities", async () => {
    const { rows } = await adminQuery(`select p.proname,p.proowner::text as owner,p.prosecdef,p.proconfig,
      pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
      pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_execute,
      pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
      exists(select 1 from pg_catalog.aclexplode(p.proacl) a
        where a.grantee<>p.proowner and (a.is_grantable or a.grantee<>
          (select r.oid from pg_catalog.pg_roles r where r.rolname='service_role'))) as unsafe_acl
      from pg_catalog.pg_proc p where p.oid in (
        'public.record_client_archive_audit_governed(uuid,uuid,uuid,uuid,boolean,text)'::regprocedure,
        'public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb)'::regprocedure)`);
    expect(rows).toHaveLength(2);
    expect(rows[0].owner).toBe(rows[1].owner);
    const { rows: roles } = await adminQuery(`select r.rolname,
      pg_catalog.pg_has_role(r.oid,$1::oid,'MEMBER') as member,
      pg_catalog.pg_has_role(r.oid,$1::oid,'SET') as can_assume
      from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')`, [rows[0].owner]);
    expect(roles).toHaveLength(4);
    for (const role of roles) expect(role).toMatchObject({ member: false, can_assume: false });
    const { rows: [identity] } = await adminQuery(`select
      pg_catalog.has_table_privilege('service_role','public.practitioners','UPDATE') as runtime_update,
      pg_catalog.has_any_column_privilege('service_role','public.practitioners','UPDATE') as runtime_column_update,
      pg_catalog.has_table_privilege($1::oid,'public.practitioners','UPDATE') as owner_lock_authority`, [rows[0].owner]);
    expect(identity).toEqual({ runtime_update: false, runtime_column_update: false, owner_lock_authority: true });
    await expect(asRole("service_role", q => q("select id from public.practitioners where false for update")))
      .rejects.toMatchObject({ code: "42501" });
    for (const row of rows) {
      expect(row).toMatchObject({ prosecdef: true, anon_execute: false, auth_execute: false, service_execute: true, unsafe_acl: false });
      expect(row.proconfig).toEqual(['search_path=""', "lock_timeout=5s"]);
    }
  });

  it.each([
    ["missing command", "alter function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) rename to test_0242_missing_command", "Unsafe governed audit command execution context"],
    ["invoker context", "alter function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) security invoker", "Unsafe governed audit command execution context"],
    ["unsafe path", "alter function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) set search_path=public", "Unsafe governed audit command execution context"],
    ["authenticated execute", "grant execute on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) to authenticated", "Unsafe governed audit command execution privileges"],
    ["service grant option", "grant execute on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) to service_role with grant option", "Unsafe governed audit command execution privileges"],
    ["missing service execute", "revoke all on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) from service_role", "Unsafe governed audit command execution privileges"],
  ])("actual0242 preflight rejects %s without privilege repair", async (_name, mutation, message) => {
    const sql = readFileSync("supabase/migrations/0242_close_direct_generic_audit_inserts.sql", "utf8");
    const preflight = sql.slice(sql.lastIndexOf("do $$"), sql.lastIndexOf("\ncommit;"));
    await adminTx(async q => {
      await q(preflight);
      await q("savepoint audit_context_negative");
      try {
        await q(mutation);
        await expect(q(preflight)).rejects.toMatchObject({ code: "P0001", message });
      } finally {
        await q("rollback to savepoint audit_context_negative");
      }
      await q(preflight);
    });
  });

  it("rolls back audit and locks with caller transaction", async () => {
    const s = await seedStudio("aud0242-rollback"); const args = await exportArgs(s);
    await expect(adminTx(async q => {
      await q("set local role service_role");
      expect((await q(exportSQL,args)).rows[0].recorded).toBe(true);
      throw new Error("synthetic audit rollback");
    })).rejects.toThrow("synthetic audit rollback");
    expect(await rowsFor(s.studioId)).toEqual([]);
  });
  it("refuses cross-user/client/studio, unapproved metadata and runtime EXECUTE", async () => {
    const s = await seedStudio("aud0242-scope"); const other = await seedStudio("aud0242-other");
    const args = await exportArgs(s);
    for (const changed of [
      [other.practitionerId,...args.slice(1)], [args[0],other.userId,...args.slice(2)],
      [args[0],args[1],other.studioId,...args.slice(3)],
      [...args.slice(0,4),["PRIVATE.csv","manifest.json","README.txt"],{ PRIVATE: 0 }],
      [...args.slice(0,5),{ clients: -1 }],
    ]) expect((await serviceCommand(q => q(exportSQL,changed))).rows[0].recorded).toBe(false);
    expect((await serviceCommand(q => q(
      "select public.record_client_archive_audit_governed($1,$2,$3,$4,false,null) as recorded",
      [s.practitionerId,s.userId,s.studioId,other.clientId]))).rows[0].recorded).toBe(false);
    for (const role of ["anon","authenticated"] as const) {
      await expect(asRole(role,q => q(exportSQL,args))).rejects.toMatchObject({code:"42501"});
    }
    expect(await rowsFor(s.studioId)).toEqual([]);
  });
});
