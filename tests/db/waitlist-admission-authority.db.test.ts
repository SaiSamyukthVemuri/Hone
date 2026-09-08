import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedMember, seedStudio } from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

// 0193 — WAIT-ADMIT-01, proved against a real local PostgreSQL.
//
// The static contract (what the migration SAYS) is pinned in
// tests/migrations/0193-waitlist-admission-authority.test.ts. This file proves
// the BEHAVIOUR that file cannot see: that a member is genuinely refused, that
// an imported join date genuinely survives the trigger, and that a prospect
// holding a valid token genuinely cannot move their own position in the queue.
//
// Fixtures are isolated by run-unique identity (seedStudio mints random UUIDs),
// never by cleanup, so this suite is safe to re-run against the same database.

afterAll(async () => {
  await closePool();
});

const TABLES = [
  "public.new_client_waitlist_entry_preferences",
  "public.new_client_waitlist_preference_grants",
  "public.studio_waitlist_admission_policy",
] as const;

const COMMANDS = [
  "public.create_practitioner_waitlist_entry(uuid,uuid,text,text,text,text)",
  "public.import_legacy_waitlist_entry(uuid,uuid,text,text,timestamptz,text,text)",
  "public.set_waitlist_entry_availability(uuid,uuid,uuid,text)",
  "public.issue_waitlist_preference_grant(uuid,uuid,uuid,integer)",
  "public.revoke_waitlist_preference_grant(uuid,uuid,uuid)",
  "public.redeem_waitlist_preference_grant(text,text)",
  "public.set_studio_waitlist_admission_policy(uuid,uuid,jsonb,integer,integer)",
  "public.claim_new_client_waitlist_entries_ordered(uuid,uuid,uuid[])",
] as const;

let n = 0;
const uniqueEmail = (label: string) => `${label}-${Date.now()}-${n++}@harness.local`;

describe("privileges are what the migration wrote, not what Supabase defaults gave", () => {
  it.each(TABLES)("anon holds nothing at all on %s", async (table) => {
    const res = await adminQuery(
      `select has_table_privilege('anon',$1,'select') as sel,
              has_table_privilege('anon',$1,'insert') as ins,
              has_table_privilege('anon',$1,'update') as upd,
              has_table_privilege('anon',$1,'delete') as del`,
      [table],
    );
    expect(res.rows[0]).toEqual({ sel: false, ins: false, upd: false, del: false });
  });

  // WHOLE-TABLE SELECT MUST BE FALSE AND COLUMN SELECT TRUE. That pair is the
  // proof the grant is column-scoped: has_table_privilege(...,'select') answers
  // "may this role read EVERY column", so a whole-table grant would flip it to
  // true and token_hash would be readable. Asserting only the column form would
  // pass either way.
  it.each(TABLES)("authenticated may read %s by column, never whole-table, never write", async (table) => {
    const res = await adminQuery(
      `select has_table_privilege('authenticated',$1,'select') as whole,
              has_any_column_privilege('authenticated',$1,'select') as cols,
              has_table_privilege('authenticated',$1,'insert') as ins,
              has_table_privilege('authenticated',$1,'update') as upd,
              has_table_privilege('authenticated',$1,'delete') as del`,
      [table],
    );
    expect(res.rows[0]).toEqual({
      whole: false,
      cols: true,
      ins: false,
      upd: false,
      del: false,
    });
  });

  it.each(TABLES)("service_role holds NO privilege on %s — only on the commands", async (table) => {
    for (const priv of ["select", "insert", "update", "delete"]) {
      const res = await adminQuery(`select has_table_privilege('service_role',$1,$2) as ok`, [
        table,
        priv,
      ]);
      expect(res.rows[0].ok, `service_role must not hold ${priv} on ${table}`).toBe(false);
    }
  });

  it("hides token_hash from authenticated while leaving the rest readable", async () => {
    const res = await adminQuery(
      `select has_column_privilege('authenticated','public.new_client_waitlist_preference_grants','token_hash','select') as hash,
              has_column_privilege('authenticated','public.new_client_waitlist_preference_grants','expires_at','select') as expires`,
    );
    // RLS scopes ROWS, not COLUMNS, so a whole-table grant would have exposed a
    // live verifier to any owner who can see the row.
    expect(res.rows[0]).toEqual({ hash: false, expires: true });
  });

  it.each(COMMANDS)("no browser role may execute %s", async (fn) => {
    const res = await adminQuery(
      `select has_function_privilege('anon',$1,'execute') as anon,
              has_function_privilege('authenticated',$1,'execute') as auth,
              has_function_privilege('service_role',$1,'execute') as svc`,
      [fn],
    );
    expect(res.rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

describe("admission policy is owner-only", () => {
  it("refuses an ordinary member and writes nothing", async () => {
    const studio = await seedStudio("admit-member");
    const member = await seedMember(studio, "admit-plain");

    const res = await adminQuery(
      `select public.set_studio_waitlist_admission_policy($1,$2,$3::jsonb,$4,$5) as r`,
      [studio.studioId, member.userId, JSON.stringify({ weights: {} }), 3, 10],
    );
    expect(res.rows[0].r).toBe("not_owner");

    const rows = await adminQuery(
      `select count(*)::int as n from public.studio_waitlist_admission_policy where studio_id = $1`,
      [studio.studioId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses an owner of a DIFFERENT studio", async () => {
    const a = await seedStudio("admit-a");
    const b = await seedStudio("admit-b");
    const res = await adminQuery(
      `select public.set_studio_waitlist_admission_policy($1,$2,$3::jsonb,$4,$5) as r`,
      [a.studioId, b.userId, JSON.stringify({ weights: {} }), 1, 2],
    );
    expect(res.rows[0].r).toBe("not_a_member");
  });

  it("accepts the studio's own owner", async () => {
    const studio = await seedStudio("admit-owner");
    const res = await adminQuery(
      `select public.set_studio_waitlist_admission_policy($1,$2,$3::jsonb,$4,$5) as r`,
      [studio.studioId, studio.userId, JSON.stringify({ weights: { waitingTime: 1 } }), 3, 5],
    );
    expect(res.rows[0].r).toBe("set");
  });
});

describe("entry origin and provenance", () => {
  it("records a practitioner-created entry with its creator", async () => {
    const studio = await seedStudio("admit-manual");
    const res = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,$5,$6)`,
      [studio.studioId, studio.userId, "Walk In", uniqueEmail("walkin"), "555", "weekdays"],
    );
    expect(res.rows[0].result).toBe("created");

    const row = await adminQuery(
      `select e.source, e.joined_at_provenance,
              e.created_by_practitioner_id is not null as has_creator,
              p.preference, p.source as pref_source
         from public.new_client_waitlist_entries e
         left join public.new_client_waitlist_entry_preferences p on p.entry_id = e.id
        where e.id = $1`,
      [res.rows[0].entry_id],
    );
    expect(row.rows[0]).toEqual({
      source: "practitioner",
      joined_at_provenance: "operator_supplied",
      has_creator: true,
      preference: "weekdays",
      pref_source: "practitioner",
    });
  });

  // THE REGRESSION THIS TEST EXISTS FOR. 0185's BEFORE INSERT trigger stamped
  // joined_at := now() unconditionally. Left alone it would have discarded every
  // imported date silently — no error, no clue, and a person who has waited
  // eight months recorded as having joined today.
  it("preserves an imported join date instead of stamping today", async () => {
    const studio = await seedStudio("admit-legacy");
    const past = new Date(Date.now() - 240 * 86_400_000);
    const res = await adminQuery(
      `select * from public.import_legacy_waitlist_entry($1,$2,$3,$4,$5,$6,null)`,
      [studio.studioId, studio.userId, "Legacy Person", uniqueEmail("legacy"), past, "operator_supplied"],
    );
    expect(res.rows[0].result).toBe("imported");

    const row = await adminQuery(
      `select joined_at, joined_at_provenance from public.new_client_waitlist_entries where id = $1`,
      [res.rows[0].entry_id],
    );
    expect(new Date(row.rows[0].joined_at).toISOString()).toBe(past.toISOString());
    expect(row.rows[0].joined_at_provenance).toBe("operator_supplied");
  });

  it("still forces joined_at for the public path", async () => {
    const studio = await seedStudio("admit-public");
    const email = uniqueEmail("public");
    // The trigger's condition keys off the row's own source, so the public path
    // is unchanged: an anonymous submitter cannot forge an earlier position.
    await adminQuery(
      `insert into public.new_client_waitlist_entries (studio_id, name, email, source, joined_at)
       values ($1,'Public Person',$2,'public_booking', now() - interval '300 days')`,
      [studio.studioId, email],
    );
    const row = await adminQuery(
      `select joined_at > now() - interval '1 minute' as fresh
         from public.new_client_waitlist_entries where email = $1`,
      [email],
    );
    expect(row.rows[0].fresh).toBe(true);
  });

  it.each([
    ["form", "invalid_provenance"],
    [null, "invalid_provenance"],
  ])("refuses an import claiming provenance %s", async (prov, expected) => {
    const studio = await seedStudio("admit-prov");
    const res = await adminQuery(
      `select ri.result from public.import_legacy_waitlist_entry($1,$2,$3,$4,$5,$6,null) ri`,
      [studio.studioId, studio.userId, "X", uniqueEmail("prov"), new Date(Date.now() - 86_400_000), prov],
    );
    expect(res.rows[0].result).toBe(expected);
  });

  it("has no defaulting path for a missing or future join date", async () => {
    const studio = await seedStudio("admit-date");
    const missing = await adminQuery(
      `select ri.result from public.import_legacy_waitlist_entry($1,$2,$3,$4,null,'operator_supplied',null) ri`,
      [studio.studioId, studio.userId, "X", uniqueEmail("nodate")],
    );
    expect(missing.rows[0].result).toBe("joined_at_required");

    const future = await adminQuery(
      `select ri.result from public.import_legacy_waitlist_entry($1,$2,$3,$4,now() + interval '2 days','operator_supplied',null) ri`,
      [studio.studioId, studio.userId, "X", uniqueEmail("future")],
    );
    expect(future.rows[0].result).toBe("joined_at_in_future");
  });

  it("still refuses a nameless legacy row — name stays required", async () => {
    const studio = await seedStudio("admit-noname");
    const res = await adminQuery(
      `select ri.result from public.import_legacy_waitlist_entry($1,$2,'   ',$3,$4,'operator_supplied',null) ri`,
      [studio.studioId, studio.userId, uniqueEmail("noname"), new Date(Date.now() - 86_400_000)],
    );
    expect(res.rows[0].result).toBe("invalid_input");
  });
});

describe("the database refuses an incoherent row regardless of which command wrote it", () => {
  async function codeOf(sql: string, params: unknown[]): Promise<string> {
    try {
      await adminQuery(sql, params);
      return "NO_ERROR";
    } catch (e) {
      return (e as { code?: string }).code ?? "UNKNOWN";
    }
  }

  it("rejects an operator-originated entry with no creator", async () => {
    const studio = await seedStudio("admit-chk1");
    expect(
      await codeOf(
        `insert into public.new_client_waitlist_entries (studio_id,name,email,source,joined_at_provenance)
         values ($1,'N',$2,'practitioner','operator_supplied')`,
        [studio.studioId, uniqueEmail("chk1")],
      ),
    ).toBe("23514");
  });

  it("rejects a confirmation that predates the value it confirms", async () => {
    const studio = await seedStudio("admit-chk2");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'N',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("chk2")],
    );
    expect(
      await codeOf(
        `insert into public.new_client_waitlist_entry_preferences
           (entry_id,studio_id,preference,stated_at,confirmed_at,source)
         values ($1,$2,'both', now(), now() - interval '1 day','public_form')`,
        [entry.rows[0].entry_id, studio.studioId],
      ),
    ).toBe("23514");
  });

  it("rejects a token-authenticated answer attributed to a practitioner", async () => {
    const studio = await seedStudio("admit-chk3");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'N',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("chk3")],
    );
    expect(
      await codeOf(
        `insert into public.new_client_waitlist_entry_preferences
           (entry_id,studio_id,preference,stated_at,confirmed_at,source,recorded_by_practitioner_id)
         values ($1,$2,'both', now(), now(),'prospect_link',$3)`,
        [entry.rows[0].entry_id, studio.studioId, studio.practitionerId],
      ),
    ).toBe("23514");
  });
});

describe("the prospect's token moves their preference and nothing else", () => {
  async function seedEntry(label: string) {
    const studio = await seedStudio(label);
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,'weekdays')`,
      [studio.studioId, studio.userId, uniqueEmail(label)],
    );
    return { studio, entryId: entry.rows[0].entry_id as string };
  }

  it("permits only one live grant per entry", async () => {
    const { studio, entryId } = await seedEntry("admit-tok1");
    const first = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(first.rows[0].result).toBe("issued");
    expect(first.rows[0].raw_token).toMatch(/^[a-f0-9]{64}$/);

    const second = await adminQuery(
      `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(second.rows[0].result).toBe("grant_already_live");
  });

  it("records the answer without touching lifecycle state", async () => {
    const { studio, entryId } = await seedEntry("admit-tok2");
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    const before = await adminQuery(
      `select status, claimed_at, claimed_by_practitioner_id, invited_at, joined_at
         from public.new_client_waitlist_entries where id = $1`,
      [entryId],
    );

    const redeemed = await adminQuery(`select public.redeem_waitlist_preference_grant($1,$2) as r`, [
      grant.rows[0].raw_token,
      "weekends",
    ]);
    expect(redeemed.rows[0].r).toBe("accepted");

    const pref = await adminQuery(
      `select preference, source, recorded_by_practitioner_id
         from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [entryId],
    );
    expect(pref.rows[0]).toEqual({
      preference: "weekends",
      source: "prospect_link",
      recorded_by_practitioner_id: null,
    });

    // The whole lifecycle row is byte-identical: a prospect with a valid token
    // cannot advance, claim or reposition themselves.
    const after = await adminQuery(
      `select status, claimed_at, claimed_by_practitioner_id, invited_at, joined_at
         from public.new_client_waitlist_entries where id = $1`,
      [entryId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("answers every failure mode with the identical refusal", async () => {
    const { studio, entryId } = await seedEntry("admit-tok3");
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    const token = grant.rows[0].raw_token as string;
    await adminQuery(`select public.redeem_waitlist_preference_grant($1,'both') as r`, [token]);

    // Replay, unknown-but-well-formed, and malformed must be indistinguishable:
    // a distinguishable answer turns this into a membership oracle.
    for (const candidate of [token, "a".repeat(64), "not-a-token"]) {
      const res = await adminQuery(`select public.redeem_waitlist_preference_grant($1,'both') as r`, [
        candidate,
      ]);
      expect(res.rows[0].r).toBe("refused");
    }
  });

  it("stops honouring a revoked link", async () => {
    const { studio, entryId } = await seedEntry("admit-tok4");
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    const revoked = await adminQuery(
      `select public.revoke_waitlist_preference_grant($1,$2,$3) as r`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(revoked.rows[0].r).toBe("revoked");

    const res = await adminQuery(`select public.redeem_waitlist_preference_grant($1,'both') as r`, [
      grant.rows[0].raw_token,
    ]);
    expect(res.rows[0].r).toBe("refused");
  });
});

describe("the confirmation rule keeps two timestamps meaningful", () => {
  it("moves only confirmed_at when the answer is unchanged, and both when it changes", async () => {
    const studio = await seedStudio("admit-conf");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'C',$3,null,'weekdays')`,
      [studio.studioId, studio.userId, uniqueEmail("conf")],
    );
    const entryId = entry.rows[0].entry_id;
    const seeded = await adminQuery(
      `select stated_at from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [entryId],
    );

    const same = await adminQuery(
      `select public.set_waitlist_entry_availability($1,$2,$3,'weekdays') as r`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(same.rows[0].r).toBe("confirmed");
    const held = await adminQuery(
      `select stated_at, confirmed_at > stated_at as refreshed
         from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [entryId],
    );
    // The value's history survives: re-confirming does not rewrite stated_at.
    expect(new Date(held.rows[0].stated_at).toISOString()).toBe(
      new Date(seeded.rows[0].stated_at).toISOString(),
    );
    expect(held.rows[0].refreshed).toBe(true);

    const changed = await adminQuery(
      `select public.set_waitlist_entry_availability($1,$2,$3,'both') as r`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(changed.rows[0].r).toBe("changed");
    const reseeded = await adminQuery(
      `select stated_at = confirmed_at as reseeded
         from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [entryId],
    );
    expect(reseeded.rows[0].reseeded).toBe(true);
  });

  it("refuses a member recording availability", async () => {
    const studio = await seedStudio("admit-conf-mem");
    const member = await seedMember(studio, "conf-plain");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'C',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("confmem")],
    );
    const res = await adminQuery(
      `select public.set_waitlist_entry_availability($1,$2,$3,'weekdays') as r`,
      [studio.studioId, entry.rows[0].entry_id, member.userId],
    );
    expect(res.rows[0].r).toBe("not_owner");
  });
});

describe("the ordered claim", () => {
  it("claims in the order the caller supplied", async () => {
    const studio = await seedStudio("admit-claim");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await adminQuery(
        `select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`,
        [studio.studioId, studio.userId, `Person ${i}`, uniqueEmail(`claim${i}`)],
      );
      ids.push(e.rows[0].entry_id);
    }
    const order = [ids[2], ids[0]];
    const res = await adminQuery(
      `select oc.entry_id from public.claim_new_client_waitlist_entries_ordered($1,$2,$3::uuid[]) oc`,
      [studio.studioId, studio.userId, order],
    );
    expect(res.rows.map((r: { entry_id: string }) => r.entry_id)).toEqual(order);

    const untouched = await adminQuery(
      `select status from public.new_client_waitlist_entries where id = $1`,
      [ids[1]],
    );
    expect(untouched.rows[0].status).toBe("waiting");
  });

  it("shares ONE decision instant across every row it wins", async () => {
    const studio = await seedStudio("admit-instant");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await adminQuery(
        `select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`,
        [studio.studioId, studio.userId, `P${i}`, uniqueEmail(`inst${i}`)],
      );
      ids.push(e.rows[0].entry_id);
    }
    await adminQuery(
      `select 1 from public.claim_new_client_waitlist_entries_ordered($1,$2,$3::uuid[])`,
      [studio.studioId, studio.userId, ids],
    );
    const stamps = await adminQuery(
      `select count(distinct claimed_at)::int as n from public.new_client_waitlist_entries where id = any($1::uuid[])`,
      [ids],
    );
    expect(stamps.rows[0].n).toBe(1);
  });

  it("lets a configured ceiling only tighten the bound", async () => {
    const studio = await seedStudio("admit-cap");
    await adminQuery(
      `select public.set_studio_waitlist_admission_policy($1,$2,$3::jsonb,1,2)`,
      [studio.studioId, studio.userId, JSON.stringify({ weights: {} })],
    );
    const res = await adminQuery(
      `select oc.result from public.claim_new_client_waitlist_entries_ordered($1,$2,$3::uuid[]) oc`,
      [studio.studioId, studio.userId, [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]],
    );
    expect(res.rows[0].result).toBe("exceeds_batch_max");
  });

  it("refuses a member", async () => {
    const studio = await seedStudio("admit-claim-mem");
    const member = await seedMember(studio, "claim-plain");
    const res = await adminQuery(
      `select oc.result from public.claim_new_client_waitlist_entries_ordered($1,$2,$3::uuid[]) oc`,
      [studio.studioId, member.userId, [crypto.randomUUID()]],
    );
    expect(res.rows[0].result).toBe("not_owner");
  });
});

// ===========================================================================
// CODEX EXACT-HEAD REVIEW, #685 @ 0d74b7ca — two P2 findings, both reproduced
// ===========================================================================
//
// Neither was hypothetical. Both were reproduced deterministically before the
// repair, and these are the regressions that stop them returning.
describe("an expired preference link does not strand the entry", () => {
  async function seedWithGrant(label: string) {
    const studio = await seedStudio(label);
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail(label)],
    );
    const entryId = entry.rows[0].entry_id as string;
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(grant.rows[0].result).toBe("issued");
    return { studio, entryId, token: grant.rows[0].raw_token as string };
  }

  /**
   * Expire a live grant. Both stamps move together because the ttl CHECK is
   * `expires_at > issued_at` — and this is only possible as the table owner,
   * which is itself the proof that no application role can manufacture an
   * expiry.
   */
  async function expire(entryId: string): Promise<void> {
    await adminQuery(
      `update public.new_client_waitlist_preference_grants
          set issued_at  = now() - interval '25 hours',
              expires_at = now() - interval '1 hour'
        where entry_id = $1 and redeemed_at is null and revoked_at is null`,
      [entryId],
    );
  }

  it("refuses to redeem an expired link", async () => {
    const { entryId, token } = await seedWithGrant("expired-redeem");
    await expire(entryId);
    const res = await adminQuery(`select public.redeem_waitlist_preference_grant($1,'both') as r`, [token]);
    expect(res.rows[0].r).toBe("refused");
  });

  // THE REGRESSION. The one-live-grant index keys on redeemed_at/revoked_at
  // only, so an expired grant still occupied the slot while redemption already
  // refused it: every later issue returned `grant_already_live` and the entry
  // became permanently un-issuable. Measured before the repair.
  it("issues a replacement after expiry, with no separate revoke step", async () => {
    const { studio, entryId } = await seedWithGrant("expired-reissue");
    await expire(entryId);

    const again = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(again.rows[0].result).toBe("issued");
    expect(again.rows[0].raw_token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retires the expired grant rather than leaving two unresolved rows", async () => {
    const { studio, entryId } = await seedWithGrant("expired-retire");
    await expire(entryId);
    await adminQuery(`select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const rows = await adminQuery(
      `select count(*) filter (where revoked_at is not null)::int as retired,
              count(*) filter (where redeemed_at is null and revoked_at is null)::int as live
         from public.new_client_waitlist_preference_grants where entry_id = $1`,
      [entryId],
    );
    // Exactly one live link at any time stays true; the dead one is retired.
    expect(rows.rows[0]).toEqual({ retired: 1, live: 1 });
  });

  it("allows a replacement once the grant has been REDEEMED", async () => {
    // Redeemed and revoked sit outside the one-live-grant predicate already;
    // this pins that the retirement step did not narrow it.
    const { studio, entryId, token } = await seedWithGrant("expired-after-redeem");
    const used = await adminQuery(`select public.redeem_waitlist_preference_grant($1,'both') as r`, [token]);
    expect(used.rows[0].r).toBe("accepted");
    const again = await adminQuery(
      `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(again.rows[0].result).toBe("issued");
  });

  it("allows a replacement once the grant has been REVOKED", async () => {
    const { studio, entryId } = await seedWithGrant("expired-after-revoke");
    await adminQuery(`select public.revoke_waitlist_preference_grant($1,$2,$3) as r`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const again = await adminQuery(
      `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(again.rows[0].result).toBe("issued");
  });

  it("two concurrent replacement issuers yield at most ONE new live grant", async () => {
    const { studio, entryId } = await seedWithGrant("expired-concurrent");
    await expire(entryId);

    // Both race to replace the SAME expired link.
    const both = await Promise.allSettled([
      adminQuery(`select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
        [studio.studioId, entryId, studio.userId]),
      adminQuery(`select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
        [studio.studioId, entryId, studio.userId]),
    ]);

    // Neither may raise: a loser must get a closed command result.
    for (const r of both) {
      expect(r.status, "a concurrent issuer raised instead of returning a code").toBe("fulfilled");
    }
    const results = both
      .map((r) => (r.status === "fulfilled" ? (r.value.rows[0].result as string) : "RAISED"))
      .sort();
    expect(results.filter((r) => r === "issued")).toHaveLength(1);
    expect(results.filter((r) => r === "grant_already_live")).toHaveLength(1);

    const live = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_preference_grants
        where entry_id = $1 and redeemed_at is null and revoked_at is null`,
      [entryId],
    );
    expect(live.rows[0].n).toBe(1);
  });

  it("still refuses a SECOND live link while one is genuinely live", async () => {
    const { studio, entryId } = await seedWithGrant("expired-still-guarded");
    const second = await adminQuery(
      `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
      [studio.studioId, entryId, studio.userId],
    );
    expect(second.rows[0].result).toBe("grant_already_live");
  });
});

describe("creating the FIRST preference row is serialised", () => {
  // `select ... for update` locks NOTHING when the row is absent, so both
  // callers took the insert path and the loser raised a bare unique_violation
  // instead of returning a code -- which 0185 forbids. The repair locks the
  // parent ENTRY, which always exists and is therefore a real mutex.
  //
  // The second caller is proved BLOCKED via pg_stat_activity rather than given
  // a sleep to lose: a timing race that happens to serialise proves nothing,
  // and that is exactly how the first attempt at this repro passed while the
  // defect was still live.
  async function seedEntry(label: string) {
    const studio = await seedStudio(label);
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail(label)],
    );
    return { studio, entryId: entry.rows[0].entry_id as string };
  }

  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  it("two operators cannot both create it: the second BLOCKS, then returns a code", async () => {
    const { studio, entryId } = await seedEntry("race-op-op");
    const a = await connect();
    const b = await connect();
    try {
      await a.client.query("begin");
      await b.client.query("begin");

      const first = await a.client.query(
        `select public.set_waitlist_entry_availability($1,$2,$3,'weekdays') as r`,
        [studio.studioId, entryId, studio.userId],
      );
      expect(first.rows[0].r).toBe("stated");

      // B enters while A is UNCOMMITTED.
      const second = b.client
        .query(`select public.set_waitlist_entry_availability($1,$2,$3,'weekends') as r`, [
          studio.studioId, entryId, studio.userId,
        ])
        .then((r) => ({ ok: true as const, v: r.rows[0].r as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      // The mutex is real: B is waiting on a lock, not merely slow.
      const waiting = await waitUntilBlocked(b.pid);
      expect(waiting, "the second operator must block on the entry lock").not.toBeNull();

      await a.client.query("commit");
      const result = await second;
      await b.client.query("commit");

      expect(
        result.ok,
        `the loser raised ${"code" in result ? result.code : ""} instead of returning a code`,
      ).toBe(true);
      // It saw the committed row: a change, not a duplicate insert.
      expect(result.ok && result.v).toBe("changed");
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });

  it("two prospects redeeming the same link cannot both create it", async () => {
    // One live grant per entry, so "two prospects" is two holders of the SAME
    // token — a forwarded link, or a double submit.
    const { studio, entryId } = await seedEntry("race-prospect-prospect");
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    const token = grant.rows[0].raw_token as string;

    const both = await Promise.allSettled([
      adminQuery(`select public.redeem_waitlist_preference_grant($1,'weekdays') as r`, [token]),
      adminQuery(`select public.redeem_waitlist_preference_grant($1,'weekends') as r`, [token]),
    ]);
    for (const r of both) {
      expect(r.status, "a concurrent redeemer raised instead of returning a code").toBe("fulfilled");
    }
    const results = both
      .map((r) => (r.status === "fulfilled" ? (r.value.rows[0].r as string) : "RAISED"))
      .sort();
    // Exactly one redemption wins; the other is refused, never a duplicate row.
    expect(results).toEqual(["accepted", "refused"]);

    const rows = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [entryId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("an operator and a redeeming prospect cannot both create it", async () => {
    // The CROSS-PATH race the finding named: the two commands take different
    // first locks, so the grant lock alone never serialised them.
    const { studio, entryId } = await seedEntry("race-op-prospect");
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    const a = await connect();
    const b = await connect();
    try {
      await a.client.query("begin");
      await b.client.query("begin");
      await a.client.query(
        `select public.set_waitlist_entry_availability($1,$2,$3,'weekdays') as r`,
        [studio.studioId, entryId, studio.userId],
      );

      const prospect = b.client
        .query(`select public.redeem_waitlist_preference_grant($1,'weekends') as r`, [
          grant.rows[0].raw_token,
        ])
        .then((r) => ({ ok: true as const, v: r.rows[0].r as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      const waiting = await waitUntilBlocked(b.pid);
      expect(waiting, "the prospect must block on the same entry lock").not.toBeNull();

      await a.client.query("commit");
      const result = await prospect;
      await b.client.query("commit");

      expect(result.ok, `the prospect raised ${"code" in result ? result.code : ""}`).toBe(true);
      expect(result.ok && result.v).toBe("accepted");

      const final = await adminQuery(
        `select preference, source from public.new_client_waitlist_entry_preferences where entry_id = $1`,
        [entryId],
      );
      // Exactly one row, and the later writer won cleanly.
      expect(final.rows).toHaveLength(1);
      expect(final.rows[0]).toEqual({ preference: "weekends", source: "prospect_link" });
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });
});

// ===========================================================================
// CODEX EXACT-HEAD REVIEW, #685 @ 920fbdfa — two further P2s, both from the
// PREVIOUS repair. Fixing the first-preference race introduced them.
// ===========================================================================

describe("the redemption clock is read AFTER the locks", () => {
  async function seedGranted(label: string) {
    const studio = await seedStudio(label);
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail(label)],
    );
    const entryId = entry.rows[0].entry_id as string;
    const grant = await adminQuery(
      `select * from public.issue_waitlist_preference_grant($1,$2,$3,24)`,
      [studio.studioId, entryId, studio.userId],
    );
    return { studio, entryId, token: grant.rows[0].raw_token as string };
  }

  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  // THE DEFECT: v_now was captured BEFORE the entry lock. A redemption can wait
  // on that lock for an unbounded time, so a grant that was live when the wait
  // began could expire during it — and the pre-lock timestamp made the expiry
  // re-check pass on evidence that was already stale, stamping the redemption
  // as though it happened before expiry.
  it("refuses a grant that expires WHILE the redemption waits for the lock", async () => {
    const { studio, entryId, token } = await seedGranted("clock-expire-wait");
    const holder = await connect();
    const redeemer = await connect();
    try {
      // Hold the entry lock so the redemption must queue behind it.
      await holder.client.query("begin");
      await holder.client.query(
        `select 1 from public.new_client_waitlist_entries where id = $1 for update`,
        [entryId],
      );

      const pending = redeemer.client
        .query(`select public.redeem_waitlist_preference_grant($1,'weekends') as r`, [token])
        .then((r) => ({ ok: true as const, v: r.rows[0].r as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      const waiting = await waitUntilBlocked(redeemer.pid);
      expect(waiting, "the redemption must be blocked on the entry lock").not.toBeNull();

      // THE DWELL IS LOad-BEARING, AND ITS ABSENCE MADE AN EARLIER VERSION OF
      // THIS TEST VACUOUS. The expiry must land strictly BETWEEN the pre-lock
      // clock and the post-lock one. Without the dwell the whole wait was well
      // under a second, so `now() - 1 second` was already behind the pre-lock
      // capture too and even the stale check refused -- the test passed against
      // the defect it exists to catch. Caught by its own negative control.
      await new Promise((r) => setTimeout(r, 2_500));

      // The grant dies DURING the wait, at an instant AFTER the redemption
      // started. Both stamps move together, as the ttl CHECK requires.
      await adminQuery(
        `update public.new_client_waitlist_preference_grants
            set issued_at  = now() - interval '25 hours',
                expires_at = now() - interval '1 second'
          where entry_id = $1 and redeemed_at is null and revoked_at is null`,
        [entryId],
      );
      await holder.client.query("commit");

      const result = await pending;
      expect(result.ok).toBe(true);
      // A pre-lock clock would have accepted this.
      expect(result.ok && result.v).toBe("refused");

      const rows = await adminQuery(
        `select count(*)::int as n from public.new_client_waitlist_entry_preferences where entry_id = $1`,
        [entryId],
      );
      expect(rows.rows[0].n, "an expired redemption must write no preference").toBe(0);

      const stamped = await adminQuery(
        `select count(*)::int as n from public.new_client_waitlist_preference_grants
          where entry_id = $1 and redeemed_at is not null`,
        [entryId],
      );
      expect(stamped.rows[0].n, "an expired grant must not be stamped redeemed").toBe(0);
      void studio;
    } finally {
      await holder.client.end();
      await redeemer.client.end();
    }
  });

  it("still redeems a grant that is STILL live once the lock is acquired", async () => {
    // The control: the same wait, without the expiry. Without it the test above
    // would pass against a command that refuses everything.
    const { entryId, token } = await seedGranted("clock-still-live");
    const holder = await connect();
    const redeemer = await connect();
    try {
      await holder.client.query("begin");
      await holder.client.query(
        `select 1 from public.new_client_waitlist_entries where id = $1 for update`,
        [entryId],
      );
      const pending = redeemer.client
        .query(`select public.redeem_waitlist_preference_grant($1,'weekends') as r`, [token])
        .then((r) => r.rows[0].r as string);
      expect(await waitUntilBlocked(redeemer.pid)).not.toBeNull();
      await holder.client.query("commit");
      expect(await pending).toBe("accepted");
    } finally {
      await holder.client.end();
      await redeemer.client.end();
    }
  });
});

describe("issuing a grant cannot deadlock against admission", () => {
  // THE DEFECT: inserting a grant takes an implicit FK key-share lock on
  // `studios`, so locking only the entry gave issue_ a real order of
  // ENTRY -> STUDIO while admit_ takes STUDIO -> ENTRY. Two of those meeting
  // deadlock. The repair takes studios explicitly and first, everywhere.
  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  // DETERMINISTIC HAZARD REPRODUCTION.
  //
  // A real admit_ cannot be paused mid-function, so the cycle cannot be forced
  // by calling it: whichever command reaches the entry first simply blocks the
  // other and they serialise. An earlier version of this test did exactly that
  // and PASSED against the defect -- caught by its own negative control.
  //
  // So the hazard is staged with explicit statements that model admit_'s order
  // exactly (studios, then the entry), while issue_ runs for real:
  //
  //   A: hold studios
  //   B: run issue_  -- sabotaged, this takes the ENTRY and then needs studios
  //   A: reach for the entry
  //
  // With the entry -> studio order that is a cycle and PostgreSQL raises 40P01.
  // With studio -> entry, B blocks on studios holding NOTHING, A takes the
  // entry freely, and the two serialise.
  it("does not deadlock when admission's lock order meets a concurrent issue", async () => {
    const studio = await seedStudio("deadlock-staged");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("deadlock")],
    );
    const entryId = entry.rows[0].entry_id as string;

    const a = await connect();
    const b = await connect();
    try {
      // A takes studios, exactly as admit_ does first.
      await a.client.query("begin");
      await a.client.query(`select 1 from public.studios where id = $1 for update`, [
        studio.studioId,
      ]);

      const issuing = b.client
        .query(`select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`, [
          studio.studioId, entryId, studio.userId,
        ])
        .then((r) => ({ ok: true as const, v: r.rows[0].result as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      expect(await waitUntilBlocked(b.pid), "the issuer must block").not.toBeNull();

      // A now reaches for the entry, as admit_ does second. If the issuer is
      // holding it while waiting on studios, this closes the cycle.
      const advancing = a.client
        .query(`select 1 from public.new_client_waitlist_entries where id = $1 for update`, [entryId])
        .then(() => ({ ok: true as const }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      const advanced = await advancing;
      expect(
        advanced.ok,
        `admission's entry lock failed with ${"code" in advanced ? advanced.code : ""} (40P01 = deadlock)`,
      ).toBe(true);

      await a.client.query("commit");
      const result = await issuing;
      expect(
        result.ok,
        `issuing failed with ${"code" in result ? result.code : ""} (40P01 = deadlock)`,
      ).toBe(true);
      expect(result.ok && result.v).toBe("issued");
    } finally {
      await a.client.query("rollback").catch(() => undefined);
      await a.client.end();
      await b.client.end();
    }
  });

  it("the reverse arrival order is equally safe", async () => {
    // Same two commands, opposite order. A single ordering that only works one
    // way round is not an ordering.
    const studio = await seedStudio("deadlock-issue-admit");
    await adminQuery(
      `insert into public.studio_waitlist_admission_rounds (studio_id, allowance) values ($1,5)`,
      [studio.studioId],
    );
    const service = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes)
       values ($1,'Svc',30) returning id`,
      [studio.studioId],
    );
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("deadlock2")],
    );
    const entryId = entry.rows[0].entry_id as string;

    const a = await connect();
    const b = await connect();
    try {
      await a.client.query("begin");
      const issued = await a.client.query(
        `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`,
        [studio.studioId, entryId, studio.userId],
      );
      expect(issued.rows[0].result).toBe("issued");

      const admitting = b.client
        .query(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`, [
          studio.studioId, studio.userId, entryId, service.rows[0].id, "2026-10-01", "2026-10-31",
        ])
        .then((r) => ({ ok: true as const, v: r.rows[0].result as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      expect(await waitUntilBlocked(b.pid), "admission must queue behind the issuer").not.toBeNull();
      await a.client.query("commit");
      const result = await admitting;

      expect(result.ok, `admission failed with ${"code" in result ? result.code : ""}`).toBe(true);
      expect(result.ok && result.v).toBe("admitted");
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });
});

// ===========================================================================
// CODEX EXACT-HEAD REVIEW, #685 @ 943c5bdf — the lock MODE, not just the order
// ===========================================================================
//
// Studio-first FOR UPDATE closed one cycle and opened another. The pre-existing
// lifecycle writers (claim_/release_/requeue_/remove_, 0185/0188) hold the ENTRY
// and then their status-event trigger inserts into
// new_client_waitlist_entry_events, whose studio_id FK requests KEY SHARE on
// studios -- which FOR UPDATE blocks, while the 0193 writer waits on the entry
// they hold. FOR NO KEY UPDATE is compatible with KEY SHARE and still excludes
// another NO KEY UPDATE, so cooperating writers serialise and FK checks pass.
//
// None of the historical lifecycle writers were edited.

describe("the studio lock mode is compatible with FK key-share", () => {
  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  // The property the whole strategy rests on, asserted against THIS database
  // rather than taken from the documentation.
  it("NO KEY UPDATE admits a KEY SHARE request; FOR UPDATE does not", async () => {
    const studio = await seedStudio("lockmode-matrix");
    async function conflicts(held: string, requested: string): Promise<boolean> {
      const a = await connect();
      const b = await connect();
      try {
        await a.client.query("begin");
        await a.client.query(`select 1 from public.studios where id = $1 ${held}`, [studio.studioId]);
        await b.client.query("begin");
        const pending = b.client
          .query(`select 1 from public.studios where id = $1 ${requested}`, [studio.studioId])
          .then(() => undefined, () => undefined);
        const blocked = (await waitUntilBlocked(b.pid)) !== null;
        await a.client.query("rollback");
        await pending;
        await b.client.query("rollback");
        return blocked;
      } finally {
        await a.client.end();
        await b.client.end();
      }
    }
    // The defect: FOR UPDATE blocks the FK's lock.
    expect(await conflicts("for update", "for key share")).toBe(true);
    // The repair: NO KEY UPDATE does not.
    expect(await conflicts("for no key update", "for key share")).toBe(false);
    // And it still serialises cooperating 0193 writers.
    expect(await conflicts("for no key update", "for no key update")).toBe(true);
  });

  // =========================================================================
  // BOUNDED LOCK-PRESENCE GUARD -- ONE NAMED ASSERTION PER COMMAND
  // =========================================================================
  //
  // WHAT THIS REPLACED, AND WHY IT IS SMALL ON PURPOSE. A general static audit
  // of this rule was built twice -- parsing the migration, then deriving from
  // pg_constraint/pg_proc/pg_trigger -- and review found eleven holes across
  // three rounds, because deciding what a PL/pgSQL body can WRITE is unbounded
  // once dynamic SQL exists. Both attempts are gone.
  //
  // This guard asks a different, decidable question. It does NOT ask what a
  // command writes, or what it can reach, or whether it needs a lock. It asks
  // only: does this NAMED command, at this EXACT signature, contain the studio
  // lock? There is no call graph, no FK frontier and no trigger map, so there
  // is nothing to walk around.
  //
  // WHY IT WAS NEEDED. Removing the general audit was measured, not assumed,
  // and the measurement was bad: with only the runtime races in place, SEVEN OF
  // NINE commands could lose their studio lock and the whole suite stayed green
  // -- admit_new_client_waitlist_entry among them. The races cover the pairs
  // they enumerate; they do not cover a lock nothing races against.
  //
  // IT OVER-APPROXIMATES, DELIBERATELY. Every listed command must carry the
  // lock whether or not this file can prove it needs one. A future command that
  // genuinely does not need it must still take it, or be removed from this list
  // by someone who says why. That is the cost of not doing reachability.
  //
  // THE LIST IS EXPLICIT AND BOUNDED. A TENTH COMMAND ADDED TO 0193 IS NOT
  // COVERED UNTIL SOMEONE ADDS IT HERE. That is a real limitation and it is
  // stated rather than hidden -- the alternative is the reachability analysis
  // that failed three times.
  //
  // Read from pg_proc, so it checks the definition the tested chain ACTUALLY
  // applied, not the text of a file that may not be what ran.
  const LOCK_BEARING_COMMANDS: ReadonlyArray<readonly [string, string]> = [
    ["create_practitioner_waitlist_entry",
     "p_studio_id uuid, p_actor_user_id uuid, p_name text, p_email text, p_phone text, p_preference text"],
    ["import_legacy_waitlist_entry",
     "p_studio_id uuid, p_actor_user_id uuid, p_name text, p_email text, p_joined_at timestamp with time zone, p_provenance text, p_phone text"],
    ["set_waitlist_entry_availability",
     "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid, p_preference text"],
    ["issue_waitlist_preference_grant",
     "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid, p_ttl_hours integer"],
    ["revoke_waitlist_preference_grant",
     "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid"],
    ["redeem_waitlist_preference_grant", "p_raw_token text, p_preference text"],
    ["set_studio_waitlist_admission_policy",
     "p_studio_id uuid, p_actor_user_id uuid, p_ranking_policy jsonb, p_invite_batch_default integer, p_invite_batch_max integer"],
    ["claim_new_client_waitlist_entries_ordered",
     "p_studio_id uuid, p_actor_user_id uuid, p_entry_ids uuid[]"],
    // The primary product seam. Its OUTER lock is the one the runtime races
    // could not see at all: removing it left the suite fully green.
    ["admit_new_client_waitlist_entry",
     "p_studio_id uuid, p_actor_user_id uuid, p_entry_id uuid, p_service_id uuid, p_start_date date, p_end_date date, p_allowed_weekdays smallint[], p_ttl_hours integer"],
  ];

  /**
   * Blank everything PostgreSQL would not EXECUTE, so the presence check cannot
   * be satisfied by inert text. Length is preserved, so any reported offset
   * still points at the right place in the original body.
   *
   * A LOCK THAT IS ONLY TEXT IS NOT A LOCK. Commenting one out with a block
   * comment left this guard green while the statement no longer ran -- measured.
   * The earlier version blanked line comments and single-quoted literals with
   * layered regexes and missed block comments entirely.
   *
   * ONE LEFT-TO-RIGHT SCAN, NOT LAYERED REGEXES, because the constructs nest
   * inside each other and layering gets the precedence wrong:
   *   * PostgreSQL block comments NEST -- an inner open/close pair inside an
   *     outer one is still ONE comment, and a non-greedy regex would stop at
   *     the first close and treat the rest as code;
   *   * a `--` inside a string is not a comment, and a quote inside a comment
   *     is not a string;
   *   * dollar-quoted bodies (`$tag$ ... $tag$`) swallow both.
   * Whichever construct opens first wins, which is exactly what the lexer does.
   */
  function executableSql(src: string): string {
    const out = src.split("");
    const blank = (from: number, to: number) => {
      for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
    };
    let i = 0;
    while (i < src.length) {
      // line comment
      if (src.startsWith("--", i)) {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? src.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      // block comment, nesting
      if (src.startsWith("/*", i)) {
        let depth = 0;
        let j = i;
        while (j < src.length) {
          if (src.startsWith("/*", j)) { depth++; j += 2; continue; }
          if (src.startsWith("*/", j)) { depth--; j += 2; if (depth === 0) break; continue; }
          j++;
        }
        blank(i, j);
        i = j;
        continue;
      }
      // dollar-quoted string
      const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i));
      if (dollar) {
        const tag = dollar[0];
        const end = src.indexOf(tag, i + tag.length);
        const stop = end === -1 ? src.length : end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
      // single-quoted literal, '' escape
      if (src[i] === "'") {
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
          if (src[j] === "'") { j++; break; }
          j++;
        }
        blank(i, j);
        i = j;
        continue;
      }
      i++;
    }
    return out.join("");
  }

  async function definitionOf(name: string, args: string): Promise<string | null> {
    const res = await adminQuery(
      `select prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = $1
          and pg_get_function_identity_arguments(p.oid) = $2`,
      [name, args],
    );
    return res.rows.length === 1 ? (res.rows[0].prosrc as string) : null;
  }

  it.each(LOCK_BEARING_COMMANDS)(
    "%s takes the studio lock in the applied definition",
    async (name, args) => {
      const src = await definitionOf(name, args);
      // A MISSING command or a CHANGED signature FAILS. It must never skip:
      // silently passing because the function was renamed is the failure this
      // assertion exists to make impossible.
      expect(src, `${name}(${args}) is not in the applied chain at this signature`).not.toBeNull();
      const body = executableSql(src as string);
      expect(
        /from\s+public\.studios[^;]*for\s+no\s+key\s+update/i.test(body),
        `${name} must take: studios ... for no key update`,
      ).toBe(true);
      // The mode matters as much as the presence: FOR UPDATE conflicts with the
      // FK's KEY SHARE and reopens the very cycle the lock closes.
      expect(
        /from\s+public\.studios[^;]*for\s+update\b/i.test(body),
        `${name} must not use the incompatible FOR UPDATE mode`,
      ).toBe(false);
    },
  );

  it("covers every command 0193 defines, at every signature", async () => {
    // KEYED ON (name, signature), NOT NAME. An OVERLOAD of a listed command --
    // same name, new argument list, no studio lock -- was in both sets under a
    // name-only comparison, so it drifted in unnoticed while the per-command
    // assertion checked only the listed signature. Measured: 75/75 green with
    // an unguarded writer present.
    //
    // Signatures come from pg_proc rather than from parsing the file's argument
    // lists: the applied definition is what runs, and hand-parsing SQL argument
    // syntax is the kind of text analysis this guard exists to avoid.
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/0193_waitlist_admission_authority.sql", "utf8");
    const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const definedNames = new Set<string>();
    const re = /create or replace function public\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const body = code.slice(m.index, code.indexOf("$$;", m.index));
      if (/returns trigger/.test(body)) continue; // triggers take no locks of their own
      definedNames.add(m[1]);
    }
    expect(definedNames.size, "no commands parsed out of 0193").toBeGreaterThanOrEqual(9);

    const live = await adminQuery(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
          and pg_get_function_result(p.oid) <> 'trigger'`,
      [[...definedNames]],
    );
    const listed = new Set(LOCK_BEARING_COMMANDS.map(([n, a]) => `${n}(${a})`));
    const unlisted = (live.rows as { name: string; args: string }[])
      .map((r) => `${r.name}(${r.args})`)
      .filter((k) => !listed.has(k));
    expect(
      unlisted,
      "a command or OVERLOAD exists without a lock-presence assertion; add it to LOCK_BEARING_COMMANDS or say why it is exempt",
    ).toEqual([]);
  });
});

describe("0193 writers do not deadlock the historical lifecycle writers", () => {
  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  async function scenario(label: string) {
    const studio = await seedStudio(label);
    await adminQuery(
      `insert into public.studio_waitlist_admission_rounds (studio_id, allowance) values ($1,5)
       on conflict (studio_id) do update set allowance = 5`,
      [studio.studioId],
    );
    const service = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes)
       values ($1,'Svc',30) returning id`,
      [studio.studioId],
    );
    const mk = async (tag: string) => {
      const e = await adminQuery(
        `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
        [studio.studioId, studio.userId, uniqueEmail(`${label}-${tag}`)],
      );
      return e.rows[0].entry_id as string;
    };
    return { studio, serviceId: service.rows[0].id as string, mk };
  }

  /**
   * Stage the REAL cycle. An earlier version of this helper raced the two
   * commands on DIFFERENT entries and passed against the defect: the lifecycle
   * writer had already taken everything it needed before the 0193 writer
   * started, so the 0193 writer simply queued and no cycle could form. Caught
   * by its own negative control.
   *
   * The cycle needs the SAME entry, and the lifecycle writer holding it BEFORE
   * it asks for the studio:
   *
   *   A: hold entry E                       (explicit lock, no trigger yet)
   *   B: 0193 writer on E -> takes studios, then WAITS for E
   *   A: run the lifecycle command on E -> its event trigger now asks for
   *      studios KEY SHARE, which a FOR UPDATE held by B blocks
   *                                        => B waits E, A waits studios = 40P01
   *
   * Under NO KEY UPDATE the KEY SHARE request is admitted, A completes, and B
   * proceeds when A commits.
   */
  async function race(
    entryId: string,
    lifecycleSql: string,
    lifecycleArgs: unknown[],
    otherSql: string,
    otherArgs: unknown[],
  ): Promise<{ lifecycle: string; other: string }> {
    const a = await connect();
    const b = await connect();
    try {
      await a.client.query("begin");
      // A holds the entry, but has NOT yet taken any studio lock.
      await a.client.query(
        `select 1 from public.new_client_waitlist_entries where id = $1 for update`,
        [entryId],
      );

      // B takes the studio lock, then blocks waiting for A's entry.
      const second = b.client
        .query(otherSql, otherArgs)
        .then((r) => ({ ok: true as const, row: r.rows[0] }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code ?? "?" }));
      await waitUntilBlocked(b.pid);

      // A now runs the real lifecycle command. Its trigger asks for studios.
      const first = await a.client
        .query(lifecycleSql, lifecycleArgs)
        .then((r) => ({ ok: true as const, row: r.rows[0] }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code ?? "?" }));

      await a.client.query("commit").catch(() => undefined);
      const other = await second;
      await b.client.query("commit").catch(() => undefined);

      return {
        lifecycle: first.ok ? String(Object.values(first.row)[0]) : `SQLSTATE ${first.code}`,
        other: other.ok ? String(Object.values(other.row)[0]) : `SQLSTATE ${other.code}`,
      };
    } finally {
      await a.client.end();
      await b.client.end();
    }
  }

  const ISSUE = `select gi.result from public.issue_waitlist_preference_grant($1,$2,$3,24) gi`;
  const ADMIT = `select ar.result from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72) ar`;

  it("claim vs grant issue settles with no 40P01", async () => {
    const { studio, mk } = await scenario("lc-claim-issue");
    const entryId = await mk("shared");
    const r = await race(
      entryId,
      `select public.claim_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entryId, studio.userId],
      ISSUE,
      [studio.studioId, entryId, studio.userId],
    );
    expect(r.lifecycle).toBe("claimed");
    expect(r.other).toBe("issued");
  });

  it("release vs grant issue settles with no 40P01", async () => {
    const { studio, mk } = await scenario("lc-release-issue");
    const entryId = await mk("shared");
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const r = await race(
      entryId,
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entryId, studio.userId],
      ISSUE,
      [studio.studioId, entryId, studio.userId],
    );
    expect(r.other).toBe("issued");
    expect(r.lifecycle).not.toMatch(/^SQLSTATE/);
  });

  it("requeue vs grant issue settles with no 40P01", async () => {
    const { studio, mk } = await scenario("lc-requeue-issue");
    const entryId = await mk("shared");
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const r = await race(
      entryId,
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entryId, studio.userId],
      ISSUE,
      [studio.studioId, entryId, studio.userId],
    );
    expect(r.other).toBe("issued");
    expect(r.lifecycle).not.toMatch(/^SQLSTATE/);
  });

  it("remove vs grant issue settles with no 40P01", async () => {
    const { studio, mk } = await scenario("lc-remove-issue");
    const entryId = await mk("shared");
    const r = await race(
      entryId,
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entryId, studio.userId],
      ISSUE,
      [studio.studioId, entryId, studio.userId],
    );
    expect(r.other).toBe("issued");
    expect(r.lifecycle).not.toMatch(/^SQLSTATE/);
  });

  // Admission against each lifecycle writer. What matters is that neither dies
  // of 40P01 and that admission returns a LEGAL outcome -- which is not always
  // "admitted": a release or a remove genuinely moves the entry out of an
  // admissible state, and refusing is then the correct answer, not a failure.
  it.each([
    ["claim", `select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, false, "admitted"],
    ["release", `select public.release_new_client_waitlist_entry($1,$2,$3) as r`, true, "not_admissible"],
    ["remove", `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, false, "not_admissible"],
  ])("admission vs %s settles with no deadlock and a legal outcome", async (_name, sql, needsClaim, expected) => {
    const { studio, serviceId, mk } = await scenario(`lc-admit-${_name}`);
    const entryId = await mk("shared");
    if (needsClaim) {
      await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
        studio.studioId, entryId, studio.userId,
      ]);
    }
    const r = await race(
      entryId,
      sql,
      [studio.studioId, entryId, studio.userId],
      ADMIT,
      [studio.studioId, studio.userId, entryId, serviceId, "2026-10-01", "2026-10-31"],
    );
    // 40P01 is the thing under test. Neither side may die of it.
    expect(r.lifecycle, "the lifecycle writer deadlocked").not.toMatch(/^SQLSTATE/);
    expect(r.other, "admission deadlocked").not.toMatch(/^SQLSTATE/);
    // claim -> the entry is claimed, which admission accepts (already-claimed
    // support). release / remove -> the entry has left the admissible states.
    expect(r.other).toBe(expected);
  });

  it("two concurrent 0193 writers still serialise on the studio", async () => {
    // NO KEY UPDATE must not have loosened what the studio lock exists for.
    const { studio, mk } = await scenario("lc-serialise");
    const one = await mk("one");
    const a = await connect();
    const b = await connect();
    try {
      const two = await mk("two");
      await a.client.query("begin");
      await a.client.query(ISSUE, [studio.studioId, one, studio.userId]);
      const pending = b.client
        .query(ISSUE, [studio.studioId, two, studio.userId])
        .then((r) => r.rows[0].result as string);
      expect(
        await waitUntilBlocked(b.pid),
        "a second 0193 writer must still queue on the studio",
      ).not.toBeNull();
      await a.client.query("commit");
      expect(await pending).toBe("issued");
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });
});

describe("the ranked claim does not deadlock against 0192's issuer", () => {
  // The audit's behavioural half. claim_new_client_waitlist_entries_ordered
  // UPDATEs entries, which fires 0185's record_event trigger and reaches
  // `studios` through the event table's FK -- AFTER it has locked candidates.
  // Against 0192's issue_scoped_, which holds studios FOR UPDATE and then waits
  // for the entry, that was the cycle again. Codex found this one command; the
  // mechanical sweep in the source contract found three more like it.
  async function connect(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    const pid = (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    return { client, pid };
  }

  // STAGED, BECAUSE THE OBVIOUS VERSION IS VACUOUS.
  //
  // Racing the two commands on DIFFERENT entries proves nothing: the issuer
  // never wants the entry the claim holds, so they merely queue. Measured --
  // removing the ordered claim's studio lock left that version GREEN, which is
  // how a real defect survived a test written for it.
  //
  // The cycle needs ONE entry and this order:
  //
  //   A: hold studios                    (what issue_scoped_ takes first)
  //   B: ordered claim on E -> locks E, then its record_event trigger asks for
  //      studios KEY SHARE, which A's FOR UPDATE blocks
  //   A: reach for E                     (what issue_scoped_ takes second)
  //                                      => B waits studios, A waits E = 40P01
  //
  // With the studio lock in place B blocks on studios holding NOTHING, A takes
  // the entry freely, and they serialise.
  it("does not deadlock when a ranked claim meets the issuer's lock order", async () => {
    const studio = await seedStudio("ordered-vs-0192");
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, uniqueEmail("ordered")],
    );
    const entryId = entry.rows[0].entry_id as string;

    const a = await connect();
    const b = await connect();
    try {
      // A takes studios, exactly as issue_scoped_ does first.
      await a.client.query("begin");
      await a.client.query(`select 1 from public.studios where id = $1 for update`, [
        studio.studioId,
      ]);

      const claiming = b.client
        .query(
          `select oc.result from public.claim_new_client_waitlist_entries_ordered($1,$2,$3::uuid[]) oc`,
          [studio.studioId, studio.userId, [entryId]],
        )
        .then((r) => ({ ok: true as const, v: r.rows[0].result as string }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      expect(await waitUntilBlocked(b.pid), "the ranked claim must block").not.toBeNull();

      // A now reaches for the entry, as issue_scoped_ does second. If the claim
      // is holding it while waiting on studios, this closes the cycle.
      const advancing = await a.client
        .query(`select 1 from public.new_client_waitlist_entries where id = $1 for update`, [
          entryId,
        ])
        .then(() => ({ ok: true as const }))
        .catch((e: { code?: string }) => ({ ok: false as const, code: e.code }));

      expect(
        advancing.ok,
        `the issuer's entry lock failed with ${"code" in advancing ? advancing.code : ""} (40P01 = deadlock)`,
      ).toBe(true);

      await a.client.query("commit");
      const result = await claiming;
      expect(
        result.ok,
        `the ranked claim failed with ${"code" in result ? result.code : ""} (40P01 = deadlock)`,
      ).toBe(true);
      expect(result.ok && result.v).toBe("claimed");
    } finally {
      await a.client.query("rollback").catch(() => undefined);
      await a.client.end();
      await b.client.end();
    }
  });
});
