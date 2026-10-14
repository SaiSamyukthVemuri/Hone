import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, closePool, seedMember, seedStudio } from "./helpers/harness";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";

// 0208 — BEHAVIOUR, against a real database.
//
// The source contract (the carried guard, privileges, statement inventory) is
// pinned in tests/migrations/0208-*. This file proves what the commands write,
// what they refuse, and what the guard and the evidence check make impossible:
//   - only an ACTIVE OWNER of the entry's own studio may record;
//   - a second recording, or one over a form consent, changes nothing;
//   - a missing or malformed answer writes nothing;
//   - STOP wins over every consent, recorded before or after it;
//   - consent evidence and the stored phone are write-once.

afterAll(closePool);

const SCOPE = "waitlist_operational";
const EVIDENCE = "Owner confirmation 2026-10-09: consent given directly to the studio";

/**
 * A studio whose new-client admission is a PERSISTED waitlist, so joins land.
 * Set the way the supported command sets it: permit-armed, in one transaction,
 * because the studios guard refuses any other writer of the admission fields.
 */
async function waitlistStudio(label: string) {
  const s = await seedStudio(label);
  await adminTx(async (q) => {
    await q("select set_config('hone.admission_mode_studio_id', $1, true)", [s.studioId]);
    await q(
      `update public.studios
          set new_client_admission_mode = 'waitlist',
              new_client_admission_mode_set_at = now()
        where id = $1`,
      [s.studioId],
    );
  });
  return s;
}

const uniqueEmail = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.com`;

/** The live signup command (0208). */
async function signup(
  studioId: string,
  over: Partial<{ name: string; email: string; phone: string | null; consent: boolean | null }> = {},
) {
  const r = await adminQuery(
    `select * from public.join_new_client_waitlist_with_sms_answer($1, $2, $3, $4, false, $5)`,
    [
      studioId,
      over.name ?? "Grace Hopper",
      over.email ?? uniqueEmail("signup"),
      over.phone === undefined ? "647-555-0101" : over.phone,
      over.consent === undefined ? false : over.consent,
    ],
  );
  return r.rows[0] as { result: string; entry_id: string | null };
}

/** A legacy-shaped prospect: joined before any consent question existed. */
async function legacyEntry(studioId: string, phone: string | null = "416-555-0102") {
  const r = await adminQuery(
    `select * from public.join_new_client_waitlist($1, $2, $3, $4)`,
    [studioId, "Legacy Person", uniqueEmail("legacy"), phone],
  );
  expect(r.rows[0].result).toBe("created");
  return r.rows[0].entry_id as string;
}

async function record(
  studioId: string,
  entryId: string,
  actorUserId: string | null,
  over: Partial<{
    scope: string | null;
    evidence: string | null;
    known: boolean | null;
    on: string | null;
  }> = {},
): Promise<string> {
  const r = await adminQuery(
    `select public.record_waitlist_sms_consent_by_practitioner($1, $2, $3, $4, $5, $6, $7) as r`,
    [
      studioId,
      entryId,
      actorUserId,
      over.scope === undefined ? SCOPE : over.scope,
      over.evidence === undefined ? EVIDENCE : over.evidence,
      over.known === undefined ? false : over.known,
      over.on === undefined ? null : over.on,
    ],
  );
  return r.rows[0].r as string;
}

const consentRow = async (id: string) =>
  (
    await adminQuery(
      `select phone, status,
              sms_consent_at, sms_consent_source, sms_consent_text_version,
              sms_consent_recorded_by_practitioner_id, sms_consent_scope,
              sms_consent_evidence_ref, sms_consent_given_on::text as sms_consent_given_on,
              sms_opted_out_at, sms_opt_out_source, mobile_verified_at, updated_at
         from public.new_client_waitlist_entries where id = $1`,
      [id],
    )
  ).rows[0];

const NO_CONSENT = {
  sms_consent_at: null,
  sms_consent_source: null,
  sms_consent_text_version: null,
  sms_consent_recorded_by_practitioner_id: null,
  sms_consent_scope: null,
  sms_consent_evidence_ref: null,
  sms_consent_given_on: null,
};

const stopEntry = (id: string) =>
  adminQuery(`select * from public.suppress_waitlist_prospects($1::uuid[], now())`, [[id]]);

// ---------------------------------------------------------------------------

describe("an owner records consent given outside Hone", () => {
  it("records source practitioner, the recorder, scope, evidence and the recording instant", async () => {
    const s = await waitlistStudio("c08-rec");
    const id = await legacyEntry(s.studioId);
    const before = new Date();
    expect(await record(s.studioId, id, s.userId, { known: true, on: "2026-09-12" })).toBe("recorded");
    const after = new Date();
    const row = await consentRow(id);

    expect(row.sms_consent_source).toBe("practitioner");
    expect(row.sms_consent_recorded_by_practitioner_id).toBe(s.practitionerId);
    expect(row.sms_consent_scope).toBe(SCOPE);
    expect(row.sms_consent_evidence_ref).toBe(EVIDENCE);
    expect(row.sms_consent_given_on).toBe("2026-09-12");
    // The recording instant, from the database clock, never back-dated to
    // the day the person agreed.
    expect(row.sms_consent_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2_000);
    expect(row.sms_consent_at.getTime()).toBeLessThanOrEqual(after.getTime() + 2_000);
    // NO INVENTED WORDING: nobody was shown the public sentence.
    expect(row.sms_consent_text_version).toBeNull();
    // Consent is not verification, and the binding is the stored number.
    expect(row.mobile_verified_at).toBeNull();
    expect(row.phone).toBe("416-555-0102");
    // D4(2): the recorded consent makes the prospect eligible.
    expect(prospectMayReceiveSms(row)).toBe(true);
  });

  it("an unknown consent date is recorded as unknown, never guessed", async () => {
    const s = await waitlistStudio("c08-unknown");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId, { known: false, on: null })).toBe("recorded");
    const row = await consentRow(id);
    expect(row.sms_consent_given_on).toBeNull();
    expect(row.sms_consent_source).toBe("practitioner");
  });

  it("stores the evidence reference trimmed", async () => {
    const s = await waitlistStudio("c08-trim");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId, { evidence: "   paper form, box 3   " })).toBe("recorded");
    expect((await consentRow(id)).sms_consent_evidence_ref).toBe("paper form, box 3");
  });
});

describe("authorization: only an active owner of the entry's own studio", () => {
  it("a non-owner member is refused and nothing is written", async () => {
    const s = await waitlistStudio("c08-member");
    const member = await seedMember(s, "c08-member");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, member.userId)).toBe("not_owner");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("the owner of ANOTHER studio is not a member here", async () => {
    const s = await waitlistStudio("c08-other-a");
    const other = await waitlistStudio("c08-other-b");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, other.userId)).toBe("not_a_member");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("an entry of another studio is not found through this studio (tenancy)", async () => {
    const a = await waitlistStudio("c08-ten-a");
    const b = await waitlistStudio("c08-ten-b");
    const idInB = await legacyEntry(b.studioId);
    expect(await record(a.studioId, idInB, a.userId)).toBe("not_found");
    expect(await consentRow(idInB)).toMatchObject(NO_CONSENT);
  });

  it("an inactive owner and an unknown user are not members", async () => {
    const s = await waitlistStudio("c08-inactive");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, randomUUID())).toBe("not_a_member");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [s.practitionerId]);
    expect(await record(s.studioId, id, s.userId)).toBe("not_a_member");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("no application role but service_role can execute either command", async () => {
    const recordSig =
      "public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date)";
    const signupSig =
      "public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean)";
    for (const role of ["anon", "authenticated"] as const) {
      for (const sig of [recordSig, signupSig]) {
        const can = await asRole(role, (q) =>
          q(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig]),
        );
        expect(can.rows[0].ok, `${role} must not execute ${sig}`).toBe(false);
      }
    }
    for (const sig of [recordSig, signupSig]) {
      const r = await adminQuery(`select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [sig]);
      expect(r.rows[0].ok, `service_role must execute ${sig}`).toBe(true);
    }
  });
});

describe("repeat recording and existing evidence: nothing is ever replaced", () => {
  it("a second recording answers already_consented and the row is byte-identical", async () => {
    const s = await waitlistStudio("c08-repeat");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId, { known: true, on: "2026-08-01" })).toBe("recorded");
    const first = await consentRow(id);
    expect(
      await record(s.studioId, id, s.userId, { known: false, evidence: "a different note entirely" }),
    ).toBe("already_consented");
    expect(await consentRow(id)).toEqual(first);
  });

  it("a consent the person gave on the public form is kept, never overwritten", async () => {
    const s = await waitlistStudio("c08-form");
    const out = await signup(s.studioId, { consent: true });
    expect(out.result).toBe("created");
    const before = await consentRow(out.entry_id!);
    expect(before.sms_consent_source).toBe("public_form");
    expect(await record(s.studioId, out.entry_id!, s.userId)).toBe("already_consented");
    expect(await consentRow(out.entry_id!)).toEqual(before);
  });
});

describe("missing or malformed answers write nothing", () => {
  const cases: Array<[string, Parameters<typeof record>[3]]> = [
    ["no scope", { scope: null }],
    ["an unknown scope", { scope: "marketing" }],
    ["no evidence", { evidence: null }],
    ["evidence under 3 characters", { evidence: " a " }],
    ["evidence over 200 characters", { evidence: "x".repeat(201) }],
    ["evidence with a control character", { evidence: "line one\nline two" }],
    ["no date-known answer", { known: null }],
    ["date said known but missing", { known: true, on: null }],
    ["date said unknown but given", { known: false, on: "2026-09-01" }],
    ["a date before 2000", { known: true, on: "1999-12-31" }],
    ["a date in the future", { known: true, on: "2999-01-01" }],
  ];
  for (const [label, over] of cases) {
    it(`refuses ${label}`, async () => {
      const s = await waitlistStudio("c08-bad");
      const id = await legacyEntry(s.studioId);
      expect(await record(s.studioId, id, s.userId, over)).toBe("invalid_input");
      expect(await consentRow(id)).toMatchObject(NO_CONSENT);
    });
  }

  it("refuses a null actor without reading the entry", async () => {
    const s = await waitlistStudio("c08-null-actor");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, null)).toBe("invalid_input");
  });
});

describe("STOP precedence and the phone binding", () => {
  it("an opted-out prospect cannot be recorded as consenting", async () => {
    const s = await waitlistStudio("c08-stop-first");
    const id = await legacyEntry(s.studioId);
    await stopEntry(id);
    expect(await record(s.studioId, id, s.userId)).toBe("opted_out");
    const row = await consentRow(id);
    expect(row).toMatchObject(NO_CONSENT);
    expect(row.sms_opt_out_source).toBe("twilio_stop");
  });

  it("a STOP after a recorded consent wins, and the consent evidence is kept", async () => {
    const s = await waitlistStudio("c08-stop-after");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId)).toBe("recorded");
    const consented = await consentRow(id);
    await stopEntry(id);
    const row = await consentRow(id);
    expect(row.sms_opted_out_at).not.toBeNull();
    expect(row.sms_consent_at).toEqual(consented.sms_consent_at);
    expect(row.sms_consent_source).toBe("practitioner");
    expect(prospectMayReceiveSms(row)).toBe(false);
  });

  it("refuses an entry with no stored number: consent binds to a number", async () => {
    const s = await waitlistStudio("c08-nophone");
    const id = await legacyEntry(s.studioId, null);
    expect(await record(s.studioId, id, s.userId)).toBe("no_phone");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("refuses a removed entry: it can never be invited", async () => {
    const s = await waitlistStudio("c08-removed");
    const id = await legacyEntry(s.studioId);
    const removed = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1, $2, $3) as r`,
      [s.studioId, id, s.userId],
    );
    expect(removed.rows[0].r).toBe("removed");
    expect(await record(s.studioId, id, s.userId)).toBe("not_active");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("the stored number stays bound: it can never be replaced once consent exists", async () => {
    const s = await waitlistStudio("c08-bind");
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId)).toBe("recorded");
    await expect(
      adminQuery(`update public.new_client_waitlist_entries set phone = '905-555-0199' where id = $1`, [id]),
    ).rejects.toThrow(/a stored mobile may not be replaced or cleared/);
  });
});

describe("consent evidence is write-once and correctly shaped (the database itself)", () => {
  async function consentedEntry(label: string) {
    const s = await waitlistStudio(label);
    const id = await legacyEntry(s.studioId);
    expect(await record(s.studioId, id, s.userId, { known: true, on: "2026-09-01" })).toBe("recorded");
    return { s, id };
  }

  const WRITE_ONCE = /consent evidence is write-once/;

  it("refuses re-timing the consent", async () => {
    const { id } = await consentedEntry("c08-wo-at");
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries set sms_consent_at = sms_consent_at - interval '1 day' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(WRITE_ONCE);
  });

  it("refuses changing the evidence, the scope, the date or the recorder", async () => {
    const { s, id } = await consentedEntry("c08-wo-fields");
    const member = await seedMember(s, "c08-wo-fields");
    for (const set of [
      `sms_consent_evidence_ref = 'rewritten evidence'`,
      `sms_consent_given_on = date '2026-01-01'`,
      `sms_consent_recorded_by_practitioner_id = '${member.practitionerId}'`,
    ]) {
      await expect(
        adminQuery(`update public.new_client_waitlist_entries set ${set} where id = $1`, [id]),
      ).rejects.toThrow(WRITE_ONCE);
    }
  });

  it("refuses removing the consent: withdrawal is a STOP, not an edit", async () => {
    const { id } = await consentedEntry("c08-wo-clear");
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries
            set sms_consent_at = null, sms_consent_source = null,
                sms_consent_recorded_by_practitioner_id = null, sms_consent_scope = null,
                sms_consent_evidence_ref = null, sms_consent_given_on = null
          where id = $1`,
        [id],
      ),
    ).rejects.toThrow(WRITE_ONCE);
  });

  it("a practitioner record can never carry public-form wording", async () => {
    const s = await waitlistStudio("c08-shape-wording");
    const id = await legacyEntry(s.studioId);
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries
            set sms_consent_at = now(), sms_consent_source = 'practitioner',
                sms_consent_text_version = 'waitlist_sms_operational_v1',
                sms_consent_recorded_by_practitioner_id = $2,
                sms_consent_scope = 'waitlist_operational',
                sms_consent_evidence_ref = 'some evidence'
          where id = $1`,
        [id, s.practitionerId],
      ),
    ).rejects.toThrow(/sms_consent_evidence_check/);
  });

  it("a practitioner record without its recorder, scope or evidence is unrepresentable", async () => {
    const s = await waitlistStudio("c08-shape-missing");
    const id = await legacyEntry(s.studioId);
    const full = {
      recorder: `'${s.practitionerId}'`,
      scope: `'waitlist_operational'`,
      evidence: `'some evidence'`,
    };
    for (const missing of ["recorder", "scope", "evidence"] as const) {
      const v = { ...full, [missing]: "null" };
      await expect(
        adminQuery(
          `update public.new_client_waitlist_entries
              set sms_consent_at = now(), sms_consent_source = 'practitioner',
                  sms_consent_recorded_by_practitioner_id = ${v.recorder},
                  sms_consent_scope = ${v.scope},
                  sms_consent_evidence_ref = ${v.evidence}
            where id = $1`,
          [id],
        ),
        `missing ${missing} must be refused`,
      ).rejects.toThrow(/sms_consent_evidence_check/);
    }
  });

  it("the recorder can never be another studio's practitioner (same-studio actor FK)", async () => {
    const s = await waitlistStudio("c08-fk-a");
    const other = await waitlistStudio("c08-fk-b");
    const id = await legacyEntry(s.studioId);
    let code = "NO_ERROR";
    try {
      await adminQuery(
        `update public.new_client_waitlist_entries
            set sms_consent_at = now(), sms_consent_source = 'practitioner',
                sms_consent_recorded_by_practitioner_id = $2,
                sms_consent_scope = 'waitlist_operational',
                sms_consent_evidence_ref = 'some evidence'
          where id = $1`,
        [id, other.practitionerId],
      );
    } catch (e) {
      code = (e as { code?: string }).code ?? "UNKNOWN";
    }
    expect(code, "a cross-studio recorder must be a foreign_key_violation").toBe("23503");
    expect(await consentRow(id)).toMatchObject(NO_CONSENT);
  });

  it("a form consent can never carry practitioner provenance", async () => {
    const s = await waitlistStudio("c08-shape-form");
    const id = await legacyEntry(s.studioId);
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries
            set sms_consent_at = now(), sms_consent_source = 'public_form',
                sms_consent_text_version = 'waitlist_sms_operational_v1',
                sms_consent_evidence_ref = 'smuggled'
          where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/sms_consent_evidence_check/);
  });
});

describe("the live signup requires an explicit Yes or No", () => {
  const entriesFor = async (studioId: string, email: string) =>
    (
      await adminQuery(
        `select count(*)::int as n from public.new_client_waitlist_entries
          where studio_id = $1 and email_normalized = lower($2)`,
        [studioId, email],
      )
    ).rows[0].n as number;

  it("a missing answer is refused and NO entry is created", async () => {
    const s = await waitlistStudio("c08-su-missing");
    const email = uniqueEmail("missing");
    expect((await signup(s.studioId, { email, consent: null })).result).toBe("invalid_input");
    expect(await entriesFor(s.studioId, email)).toBe(0);
  });

  it("Yes without a usable number is refused and NO entry is created", async () => {
    const s = await waitlistStudio("c08-su-nophone");
    for (const phone of [null, "   ", "555-12"]) {
      const email = uniqueEmail("nophone");
      expect((await signup(s.studioId, { email, phone, consent: true })).result).toBe("invalid_input");
      expect(await entriesFor(s.studioId, email)).toBe(0);
    }
  });

  it("Yes records the public sentence, from the database clock, bound to the stored number", async () => {
    const s = await waitlistStudio("c08-su-yes");
    const before = new Date();
    const out = await signup(s.studioId, { phone: " 647-555-0123 ", consent: true });
    const after = new Date();
    expect(out.result).toBe("created");
    const row = await consentRow(out.entry_id!);
    expect(row.phone).toBe("647-555-0123");
    expect(row.sms_consent_source).toBe("public_form");
    expect(row.sms_consent_text_version).toBe("waitlist_sms_operational_v1");
    expect(row.sms_consent_recorded_by_practitioner_id).toBeNull();
    expect(row.sms_consent_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2_000);
    expect(row.sms_consent_at.getTime()).toBeLessThanOrEqual(after.getTime() + 2_000);
    expect(prospectMayReceiveSms(row)).toBe(true);
  });

  it("No keeps the place on the waitlist and records no consent at all", async () => {
    const s = await waitlistStudio("c08-su-no");
    const out = await signup(s.studioId, { consent: false });
    expect(out.result).toBe("created");
    const row = await consentRow(out.entry_id!);
    expect(row.status).toBe("waiting");
    expect(row).toMatchObject(NO_CONSENT);
    expect(prospectMayReceiveSms(row)).toBe(false);
  });

  it("No without a phone is a normal join", async () => {
    const s = await waitlistStudio("c08-su-no-phone");
    const out = await signup(s.studioId, { phone: null, consent: false });
    expect(out.result).toBe("created");
    expect((await consentRow(out.entry_id!)).phone).toBeNull();
  });

  it("a later Yes from the public form cannot change an existing entry", async () => {
    const s = await waitlistStudio("c08-su-dup");
    const email = uniqueEmail("dup");
    const first = await signup(s.studioId, { email, consent: false });
    expect(first.result).toBe("created");
    const again = await signup(s.studioId, { email, consent: true });
    expect(again.result).toBe("already_waiting");
    expect(again.entry_id).toBe(first.entry_id);
    expect(await consentRow(first.entry_id!)).toMatchObject(NO_CONSENT);
  });

  it("the admission gate still decides first: a studio not taking joins writes nothing", async () => {
    const s = await seedStudio("c08-su-closed"); // admission defaults to open, never waitlist
    const email = uniqueEmail("closed");
    const out = await signup(s.studioId, { email, consent: true });
    expect(out.result).toBe("new_client_admission_refused");
    expect(await entriesFor(s.studioId, email)).toBe(0);
  });
});
