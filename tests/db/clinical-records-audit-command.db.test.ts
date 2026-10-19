import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio } from "./helpers/harness";
import { countVersion } from "../migrations/helpers/migration-state";

// 0233 (HON-46, Codex P1 4304545551): the clinical-records audit is
// ACTOR-BOUND. A studio member can no longer write clinical_records_* rows
// directly, nor any audit row naming another practitioner as actor; the ONE
// way in is record_clinical_records_audit, which records auth.uid()'s own
// owner row. The two remaining member-path writers (client archive/unarchive,
// studio data export) still work: they name their own actor.

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
