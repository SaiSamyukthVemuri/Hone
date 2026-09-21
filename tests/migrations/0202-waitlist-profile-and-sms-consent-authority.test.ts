import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";
import { TREATMENT_AREA_IDS } from "@/lib/waitlist/treatment-area-catalog";
import { AVAILABILITY_PREFERENCES } from "@/lib/waitlist/join-profile";
import {
  SMS_CONSENT_SOURCES,
  SMS_OPT_OUT_SOURCES,
  SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
} from "@/lib/waitlist/prospect-sms-consent";

// 0202 — DURABLE PROSPECT PROFILE AND SMS CONSENT AUTHORITY.
//
// SOURCE CONTRACT ONLY. Behaviour is proved against a real database in
// tests/db/waitlist-profile-and-sms-consent-authority.db.test.ts. An
// admin-connection source test cannot see a privilege defect — the lesson 0197
// recorded after 182 passing assertions missed one.
//
// WHAT THIS FILE PINS. The migration adds nine columns and four commands to a
// table whose whole security posture is "no role holds DML; every write is a
// command". Most of the assertions below are therefore about what the file must
// NOT contain: a table-level grant, a parameter that would let a caller narrow
// a STOP, a second contact column, or a reference to an object this slice has
// no business depending on.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0202";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

const COLUMNS = [
  "first_name",
  "last_name",
  "treatment_area_ids",
  "sms_consent_at",
  "sms_consent_source",
  "sms_consent_text_version",
  "sms_opted_out_at",
  "sms_opt_out_source",
  "mobile_verified_at",
] as const;

const COMMANDS: ReadonlyArray<[string, string]> = [
  [
    "join_new_client_waitlist_with_profile",
    "uuid, text, text, text, text, text[], text, boolean",
  ],
  [
    "complete_waitlist_profile_by_grant",
    "text, text, text, text[], text, text, boolean",
  ],
  ["waitlist_prospect_suppression_candidates", ""],
  ["suppress_waitlist_prospects", "uuid[], timestamptz"],
];

describe("0202 takes the number it derived", () => {
  it("is the repository maximum and nothing sits above it", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("claims its version exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("does not edit an applied migration", () => {
    // Every version at or below the hosted maximum is frozen. This migration
    // may only ADD a file.
    const state = migrationState();
    expect(Number(VERSION)).toBeGreaterThan(Number(state.hosted_migration_max));
  });
});

describe("it adds columns and commands, and nothing structural", () => {
  it("creates no table", () => {
    expect(CODE).not.toMatch(/create\s+table/i);
  });

  it("adds every column the frozen contract needs", () => {
    for (const col of COLUMNS) {
      expect(CODE, col).toMatch(
        new RegExp(`add column if not exists\\s+${col}\\b`, "i"),
      );
    }
  });

  it("adds NO second contact column", () => {
    // A `mobile` beside `phone` is the defect, not the tidy name: a legacy row
    // holding `phone` would read as having NO number, so a completion link
    // could write one for someone the studio already has a number for.
    expect(CODE).not.toMatch(/add column if not exists\s+mobile\b/i);
  });

  it("adds NO availability column — 0193 already owns that fact", () => {
    expect(CODE).not.toMatch(/add column if not exists\s+availability/i);
  });

  it("backfills nothing: every UPDATE of the table binds rows by id", () => {
    // THE PREVIOUS FORM OF THIS ASSERTION COULD NOT FAIL. It required `set` to
    // follow the table name on the same line, but every update in this file
    // aliases the table -- `update public.new_client_waitlist_entries e` with
    // `set` on the next line -- so no text matched it, a genuine backfill
    // written that way included. This asserts the property instead of a
    // spelling: a backfill is an update that names no row.
    const stmts = [
      ...CODE.matchAll(/update\s+public\.new_client_waitlist_entries\b[\s\S]*?;/gi),
    ].map((m) => m[0]);
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      expect(stmt, stmt.slice(0, 90)).toMatch(/\bwhere\b[\s\S]*?\b(?:e\.)?id\s*(?:=|in\b)/i);
    }
  });

  it("never writes joined_at or its provenance", () => {
    // Answering a question Hone added later cannot cost someone their place.
    expect(CODE).not.toMatch(/joined_at\s*=/);
    expect(CODE).not.toMatch(/joined_at_provenance\s*=/);
  });
});

describe("the privilege wall 0185 built still stands", () => {
  it("grants no table privilege to anyone", () => {
    expect(CODE).not.toMatch(
      /grant\s+(select|insert|update|delete|all)[\s\S]{0,80}on\s+public\.new_client_waitlist_entries/i,
    );
  });

  it("revokes EXECUTE from all four grantees by name, then grants service_role alone", () => {
    for (const [name, args] of COMMANDS) {
      const sig = `public\\.${name}\\(${args.replace(/[[\]]/g, "\\$&")}\\)`;
      for (const grantee of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE, `${name} revoke from ${grantee}`).toMatch(
          new RegExp(`revoke execute on function ${sig} from ${grantee};`, "i"),
        );
      }
      expect(CODE, `${name} granted to service_role`).toMatch(
        new RegExp(`grant execute on function ${sig} to service_role;`, "i"),
      );
    }
  });

  it("every command is SECURITY DEFINER with a pinned search_path", () => {
    const defs = CODE.match(/create or replace function public\.\w+[\s\S]*?as \$\$/gi) ?? [];
    expect(defs.length).toBeGreaterThanOrEqual(COMMANDS.length);
    for (const d of defs) {
      if (/returns trigger/i.test(d)) continue; // the guard is SECURITY INVOKER
      expect(d).toMatch(/security definer/i);
      expect(d).toMatch(/set search_path = pg_catalog, pg_temp/i);
    }
  });
});

describe("the suppression commands cannot narrow a STOP", () => {
  it("the read takes no argument at all", () => {
    expect(CODE).toMatch(
      /create or replace function public\.waitlist_prospect_suppression_candidates\(\s*\)/i,
    );
  });

  it("the stamp takes ids and an instant — never a phone, a studio or a status", () => {
    const sig = CODE.slice(
      CODE.indexOf("create or replace function public.suppress_waitlist_prospects"),
    ).slice(0, 220);
    expect(sig).toMatch(/p_entry_ids\s+uuid\[\]/i);
    expect(sig).toMatch(/p_opted_at\s+timestamptz/i);
    expect(sig).not.toMatch(/p_phone|p_studio_id|p_status/i);
  });

  it("neither command matches a phone — matching stays in TypeScript", () => {
    // There is no SQL equivalent of `normalizePhoneForMatch`. The only SQL
    // normalizer that exists is 0199's `sms_normalized_phone`, which is the
    // SEND normalizer: using it to match would NARROW a STOP and miss exactly
    // the stored values the match normalizer's fallback exists to catch.
    const read = CODE.slice(
      CODE.indexOf("function public.waitlist_prospect_suppression_candidates"),
    ).slice(0, 700);
    expect(read).not.toMatch(/regexp_replace|sms_normalized_phone|digits/i);
  });

  it("the read applies no lifecycle filter — a STOP is about a phone", () => {
    const read = CODE.slice(
      CODE.indexOf("function public.waitlist_prospect_suppression_candidates"),
    ).slice(0, 700);
    expect(read).not.toMatch(/status\s*(=|in|not in)/i);
  });
});

describe("the completion command cannot be told WHO to write", () => {
  it("has no entry-id, email or joined-at parameter", () => {
    const sig = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_profile_by_grant"),
    ).slice(0, 400);
    expect(sig).not.toMatch(/p_entry_id|p_email|p_joined_at/i);
  });

  it("resolves the entry through the hashed token, under the canonical lock order", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_profile_by_grant"),
    );
    const end = body.indexOf("$$;");
    const fn = body.slice(0, end);
    expect(fn).toMatch(/digest\(p_raw_token, 'sha256'\)/i);
    const studioLock = fn.search(/from public\.studios[\s\S]{0,40}for no key update/i);
    const entryLock = fn.search(/from public\.new_client_waitlist_entries[\s\S]{0,60}for update/i);
    expect(studioLock, "studio lock present").toBeGreaterThan(-1);
    expect(entryLock, "entry lock present").toBeGreaterThan(-1);
    expect(studioLock, "studio is locked BEFORE entry").toBeLessThan(entryLock);
    // And the clock is read after them.
    expect(fn.indexOf("clock_timestamp()")).toBeGreaterThan(entryLock);
  });

  it("mints no second grant type", () => {
    expect(CODE).not.toMatch(/create table[\s\S]{0,60}_grants/i);
  });
});

describe("vocabularies are pinned against their TypeScript source", () => {
  it("the treatment-area catalog matches TREATMENT_AREA_IDS exactly, in order", () => {
    // The SQL restates the catalog so the database re-checks independently of
    // the application. Two copies of one list is a drift risk; this is what
    // makes it fail instead.
    const block = CODE.slice(CODE.indexOf("'upper_lip'"));
    const ids = (block.match(/'[a-z_]+'/g) ?? [])
      .slice(0, TREATMENT_AREA_IDS.length)
      .map((s) => s.replace(/'/g, ""));
    expect(ids).toEqual([...TREATMENT_AREA_IDS]);
  });

  it("the consent-source check equals SMS_CONSENT_SOURCES", () => {
    for (const s of SMS_CONSENT_SOURCES) expect(CODE).toContain(`'${s}'`);
  });

  it("the opt-out-source check equals SMS_OPT_OUT_SOURCES", () => {
    for (const s of SMS_OPT_OUT_SOURCES) expect(CODE).toContain(`'${s}'`);
  });

  it("the consent text version is pinned to the shipped constant", () => {
    expect(CODE).toContain(`'${SMS_OPERATIONAL_CONSENT_TEXT_VERSION}'`);
  });

  it("the availability vocabulary equals AVAILABILITY_PREFERENCES", () => {
    for (const p of AVAILABILITY_PREFERENCES) expect(CODE).toContain(`'${p}'`);
  });
});

describe("the name budget is widened by exactly one character", () => {
  it("120 -> 121, which is 60 + separator + 60", () => {
    expect(CODE).toMatch(/length\(btrim\(name\)\) between 1 and 121/);
    expect(CODE).not.toMatch(/length\(btrim\(name\)\) between 1 and 120/);
  });

  it("leaves the phone check alone", () => {
    // Adding the seven-digit floor here would fail validation against legacy
    // rows holding "n/a" or a short landline, and would retroactively
    // invalidate values a studio entered deliberately. The floor lives in the
    // commands, which govern only new writes.
    expect(CODE).not.toMatch(/new_client_waitlist_entries_phone_check/);
  });
});

describe("no dependency on #716 / 0199", () => {
  it("references no object 0199 created", () => {
    for (const obj of [
      "sms_normalized_phone",
      "sms_trimmable_whitespace",
      "sms_phone",
      "reminder_sms_candidates",
      "reminder_sms_unroutable_studios",
    ]) {
      expect(CODE, obj).not.toContain(obj);
    }
  });
});

describe("every new column is documented", () => {
  it("carries a COMMENT ON, including one for the reused phone column", () => {
    for (const col of [...COLUMNS, "phone"]) {
      expect(SQL, col).toMatch(
        new RegExp(`comment on column public\\.new_client_waitlist_entries\\.${col} is`, "i"),
      );
    }
  });
});
