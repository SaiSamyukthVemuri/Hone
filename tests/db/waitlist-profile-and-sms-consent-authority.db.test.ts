import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedStudio } from "./helpers/harness";
import { TREATMENT_AREA_IDS } from "@/lib/waitlist/treatment-area-catalog";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";

// 0202 — BEHAVIOUR, against a real database.
//
// The source contract (shape, ACLs, vocabularies) is pinned in
// tests/migrations/0202-*. This file proves the things a source test cannot
// see: what the commands actually write, what the guard actually refuses, and
// what a role that is not service_role can actually reach.

afterAll(closePool);

/** A studio plus a full-profile join, returning the entry id. */
async function joinWithProfile(
  studioId: string,
  over: Partial<{
    first: string; last: string; email: string; mobile: string;
    areas: string[]; preference: string; consent: boolean;
  }> = {},
) {
  const r = await adminQuery(
    `select * from public.join_new_client_waitlist_with_profile($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      studioId,
      over.first ?? "Ada",
      over.last ?? "Lovelace",
      over.email ?? `ada-${Math.random().toString(16).slice(2)}@example.com`,
      over.mobile ?? "647-555-1234",
      over.areas ?? ["chin", "neck"],
      over.preference ?? "weekdays",
      over.consent ?? true,
    ],
  );
  return r.rows[0] as { result: string; entry_id: string | null };
}

const entryRow = async (id: string) =>
  (
    await adminQuery(
      `select name, first_name, last_name, phone, treatment_area_ids, status,
              sms_consent_at, sms_consent_source, sms_consent_text_version,
              sms_opted_out_at, sms_opt_out_source, mobile_verified_at,
              joined_at, joined_at_provenance, updated_at
         from public.new_client_waitlist_entries where id = $1`,
      [id],
    )
  ).rows[0];

describe("a new prospect joins with a full profile", () => {
  it("stores every answer, and stores the mobile as a CANDIDATE", async () => {
    const s = await seedStudio("w04b-join");
    const out = await joinWithProfile(s.studioId);
    expect(out.result).toBe("created");
    const row = await entryRow(out.entry_id!);

    expect(row.first_name).toBe("Ada");
    expect(row.last_name).toBe("Lovelace");
    // The combined name is composed, never split back out.
    expect(row.name).toBe("Ada Lovelace");
    // Stored as typed: the shipped path deliberately keeps a phone as a plain
    // contact string — no E.164 coercion, no dedupe, no match against clients.
    expect(row.phone).toBe("647-555-1234");
    expect(row.treatment_area_ids).toEqual(["chin", "neck"]);
    expect(row.sms_consent_source).toBe("public_form");
    expect(row.sms_consent_text_version).toBe("waitlist_sms_operational_v1");
    expect(row.sms_consent_at).not.toBeNull();

    // THE WHOLE POINT: holding a number is not permission to text it.
    expect(row.mobile_verified_at).toBeNull();
    expect(
      prospectMayReceiveSms({
        sms_consent_at: row.sms_consent_at,
        sms_opted_out_at: row.sms_opted_out_at,
        mobile_verified_at: row.mobile_verified_at,
      }),
      "consent plus a typed number must NOT be sendable",
    ).toBe(false);
  });

  it("writes availability to 0193's table, not to a second column", async () => {
    const s = await seedStudio("w04b-pref");
    const out = await joinWithProfile(s.studioId, { preference: "both" });
    const p = await adminQuery(
      `select preference, source, recorded_by_practitioner_id, stated_at, confirmed_at
         from public.new_client_waitlist_entry_preferences where entry_id = $1`,
      [out.entry_id],
    );
    expect(p.rows[0].preference).toBe("both");
    expect(p.rows[0].source).toBe("public_form");
    // A token-authenticated answer may never be attributed to a human.
    expect(p.rows[0].recorded_by_practitioner_id).toBeNull();
    // Setting a value IS confirming it.
    expect(p.rows[0].confirmed_at.getTime()).toBe(p.rows[0].stated_at.getTime());
  });

  it("records a DECLINE as three NULLs, never a timestamped false", async () => {
    const s = await seedStudio("w04b-decline");
    const out = await joinWithProfile(s.studioId, { consent: false });
    const row = await entryRow(out.entry_id!);
    expect(row.sms_consent_at).toBeNull();
    expect(row.sms_consent_source).toBeNull();
    expect(row.sms_consent_text_version).toBeNull();
    // And declining costs nothing else.
    expect(row.status).toBe("waiting");
    expect(row.first_name).toBe("Ada");
  });

  it("stamps the consent instant from the DATABASE clock", async () => {
    const s = await seedStudio("w04b-clock");
    const before = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t;
    const out = await joinWithProfile(s.studioId);
    const after = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t;
    const row = await entryRow(out.entry_id!);
    expect(row.sms_consent_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.sms_consent_at.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("REFUSES an unknown treatment area rather than silently narrowing", async () => {
    const s = await seedStudio("w04b-area");
    const bad = await joinWithProfile(s.studioId, { areas: ["chin", "not_an_area"] });
    expect(bad.result).toBe("invalid_input");
    expect(bad.entry_id).toBeNull();
  });

  it("accepts every catalog id and stores them catalog-ordered", async () => {
    const s = await seedStudio("w04b-allareas");
    const shuffled = [...TREATMENT_AREA_IDS].reverse();
    const out = await joinWithProfile(s.studioId, { areas: shuffled });
    expect(out.result).toBe("created");
    const row = await entryRow(out.entry_id!);
    expect(row.treatment_area_ids).toEqual([...TREATMENT_AREA_IDS]);
  });

  it("refuses a mobile under the digit floor, and an empty area list", async () => {
    const s = await seedStudio("w04b-bounds");
    expect((await joinWithProfile(s.studioId, { mobile: "12345" })).result).toBe("invalid_input");
    expect((await joinWithProfile(s.studioId, { areas: [] })).result).toBe("invalid_input");
  });

  it("accepts a maximal 60/60 name — the 121-character budget", async () => {
    const s = await seedStudio("w04b-name");
    const out = await joinWithProfile(s.studioId, {
      first: "A".repeat(60),
      last: "B".repeat(60),
    });
    expect(out.result, "60 + separator + 60 = 121").toBe("created");
  });

  it("a duplicate submission WRITES NOTHING — no profile-overwrite oracle", async () => {
    const s = await seedStudio("w04b-dupe");
    const email = `dupe-${Math.random().toString(16).slice(2)}@example.com`;
    const first = await joinWithProfile(s.studioId, { email });
    const before = await entryRow(first.entry_id!);

    const again = await joinWithProfile(s.studioId, {
      email,
      first: "Mallory",
      last: "Attacker",
      mobile: "416-555-0000",
      areas: ["chest"],
      preference: "weekends",
      consent: false,
    });
    expect(again.result).toBe("already_waiting");
    expect(again.entry_id).toBe(first.entry_id);

    const after = await entryRow(first.entry_id!);
    expect(after.first_name).toBe(before.first_name);
    expect(after.phone).toBe(before.phone);
    expect(after.treatment_area_ids).toEqual(before.treatment_area_ids);
    // The agreement happened once; its instant must not move.
    expect(after.sms_consent_at.getTime()).toBe(before.sms_consent_at.getTime());
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });
});

describe("the guard refuses what no command may do", () => {
  const raises = async (sql: string, params: unknown[]) => {
    await expect(adminQuery(sql, params)).rejects.toThrow();
  };

  it("joined_at is immutable — completing a profile never moves a queue place", async () => {
    const s = await seedStudio("w04b-joinedat");
    const out = await joinWithProfile(s.studioId);
    await raises(
      `update public.new_client_waitlist_entries
          set joined_at = now() - interval '30 days' where id = $1`,
      [out.entry_id],
    );
  });

  it("a stored mobile may not be replaced or cleared", async () => {
    const s = await seedStudio("w04b-mobile");
    const out = await joinWithProfile(s.studioId);
    await raises(
      `update public.new_client_waitlist_entries set phone = '999-999-9999' where id = $1`,
      [out.entry_id],
    );
    await raises(
      `update public.new_client_waitlist_entries set phone = null where id = $1`,
      [out.entry_id],
    );
  });

  it("mobile_verified_at has NO writer in this release", async () => {
    const s = await seedStudio("w04b-verify");
    const out = await joinWithProfile(s.studioId);
    await raises(
      `update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1`,
      [out.entry_id],
    );
  });

  it("an opt-out is terminal", async () => {
    const s = await seedStudio("w04b-optout");
    const out = await joinWithProfile(s.studioId);
    await adminQuery(
      `update public.new_client_waitlist_entries
          set sms_opted_out_at = now(), sms_opt_out_source = 'twilio_stop' where id = $1`,
      [out.entry_id],
    );
    await raises(
      `update public.new_client_waitlist_entries
          set sms_opted_out_at = null, sms_opt_out_source = null where id = $1`,
      [out.entry_id],
    );
    // And a later consent cannot resurrect sendability.
    const row = await entryRow(out.entry_id!);
    expect(
      prospectMayReceiveSms({
        sms_consent_at: row.sms_consent_at,
        sms_opted_out_at: row.sms_opted_out_at,
        mobile_verified_at: row.mobile_verified_at,
      }),
    ).toBe(false);
  });

  it("name and email stay immutable", async () => {
    const s = await seedStudio("w04b-identity");
    const out = await joinWithProfile(s.studioId);
    await raises(
      `update public.new_client_waitlist_entries set email = 'attacker@example.com' where id = $1`,
      [out.entry_id],
    );
  });
});

describe("legacy rows are preserved, and stay honestly incomplete", () => {
  it("a legacy-shaped row still inserts and reads as incomplete", async () => {
    const s = await seedStudio("w04b-legacy");
    const r = await adminQuery(
      `insert into public.new_client_waitlist_entries (studio_id, name, email, phone)
       values ($1, 'Old Combined Name', $2, 'n/a')
       returning id, first_name, last_name, treatment_area_ids, sms_consent_at, mobile_verified_at`,
      [s.studioId, `legacy-${Math.random().toString(16).slice(2)}@example.com`],
    );
    const row = r.rows[0];
    // Absence is modelled as absence. Nothing is invented for a question that
    // was never asked, and the combined name is never split.
    expect(row.first_name).toBeNull();
    expect(row.last_name).toBeNull();
    expect(row.treatment_area_ids).toBeNull();
    expect(row.sms_consent_at).toBeNull();
    expect(row.mobile_verified_at).toBeNull();
  });

  it("a junk phone survives the migration — the digit floor is not on the column", async () => {
    const s = await seedStudio("w04b-junk");
    // "n/a", "ask", a landline typed short: ordinary legacy values. Tightening
    // the column check would retroactively invalidate what a studio entered.
    for (const junk of ["n/a", "ask", "555"]) {
      const r = await adminQuery(
        `insert into public.new_client_waitlist_entries (studio_id, name, email, phone)
         values ($1, 'Legacy', $2, $3) returning phone`,
        [s.studioId, `junk-${junk}-${Math.random().toString(16).slice(2)}@example.com`, junk],
      );
      expect(r.rows[0].phone).toBe(junk);
    }
  });
});

describe("prospect suppression: the two halves the STOP path will need", () => {
  it("the read returns the candidate shape and nothing else about the person", async () => {
    const s = await seedStudio("w04b-supread");
    await joinWithProfile(s.studioId);
    const r = await adminQuery(`select * from public.waitlist_prospect_suppression_candidates()`);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(Object.keys(r.rows[0]).sort()).toEqual(
      ["id", "phone", "sms_opted_out_at", "studio_id"],
    );
  });

  it("the read does not filter by lifecycle — a STOP is about a phone", async () => {
    const s = await seedStudio("w04b-suplife");
    const out = await joinWithProfile(s.studioId);
    await adminQuery(
      `update public.new_client_waitlist_entries
          set status = 'removed', removed_at = now(), removed_by_practitioner_id = $2
        where id = $1`,
      [out.entry_id, s.practitionerId],
    );
    const r = await adminQuery(
      `select id from public.waitlist_prospect_suppression_candidates() where id = $1`,
      [out.entry_id],
    );
    expect(r.rows.length, "a removed entry is still suppressible").toBe(1);
  });

  it("the stamp writes both limbs, and is idempotent", async () => {
    const s = await seedStudio("w04b-supstamp");
    const out = await joinWithProfile(s.studioId);
    const at = new Date().toISOString();

    const first = await adminQuery(
      `select * from public.suppress_waitlist_prospects($1, $2)`,
      [[out.entry_id], at],
    );
    expect(first.rows.length).toBe(1);
    const row = await entryRow(out.entry_id!);
    expect(row.sms_opted_out_at).not.toBeNull();
    expect(row.sms_opt_out_source).toBe("twilio_stop");

    // Retry-dedup: a second sweep stamps nothing and re-times nothing.
    const second = await adminQuery(
      `select * from public.suppress_waitlist_prospects($1, $2)`,
      [[out.entry_id], new Date(Date.now() + 60_000).toISOString()],
    );
    expect(second.rows.length).toBe(0);
    const again = await entryRow(out.entry_id!);
    expect(again.sms_opted_out_at.getTime()).toBe(row.sms_opted_out_at.getTime());
  });

  it("a null instant stamps nothing rather than writing a half record", async () => {
    const s = await seedStudio("w04b-supnull");
    const out = await joinWithProfile(s.studioId);
    const r = await adminQuery(
      `select * from public.suppress_waitlist_prospects($1, $2)`,
      [[out.entry_id], null],
    );
    expect(r.rows.length).toBe(0);
    expect((await entryRow(out.entry_id!)).sms_opted_out_at).toBeNull();
  });
});

describe("no browser-reachable role gains anything", () => {
  it("anon and authenticated hold no DML on the entries table", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"] as const) {
        const r = await adminQuery(
          `select has_table_privilege($1, 'public.new_client_waitlist_entries', $2) as ok`,
          [role, priv],
        );
        expect(r.rows[0].ok, `${role} ${priv}`).toBe(false);
      }
    }
  });

  it("service_role holds NO privilege on the table at all — only EXECUTE on commands", async () => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      const r = await adminQuery(
        `select has_table_privilege('service_role', 'public.new_client_waitlist_entries', $1) as ok`,
        [priv],
      );
      expect(r.rows[0].ok, `service_role ${priv}`).toBe(false);
    }
  });

  it("a browser role cannot execute any of the four commands", async () => {
    const sigs = [
      "public.join_new_client_waitlist_with_profile(uuid, text, text, text, text, text[], text, boolean)",
      "public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean)",
      "public.waitlist_prospect_suppression_candidates()",
      "public.suppress_waitlist_prospects(uuid[], timestamptz)",
    ];
    for (const role of ["anon", "authenticated"] as const) {
      for (const sig of sigs) {
        const r = await adminQuery(
          `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
          [role, sig],
        );
        expect(r.rows[0].ok, `${role} -> ${sig}`).toBe(false);
      }
    }
  });

  it("an authenticated session still cannot write a profile column", async () => {
    const s = await seedStudio("w04b-priv");
    const out = await joinWithProfile(s.studioId);
    await asRole("authenticated", async (q) => {
      await expect(
        q(`update public.new_client_waitlist_entries set first_name = 'Mallory' where id = $1`, [
          out.entry_id,
        ]),
      ).rejects.toThrow();
    });
  });
});
