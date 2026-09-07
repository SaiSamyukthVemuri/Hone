import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";
import { EXPORT_RESOURCE_REGISTRY } from "@/lib/export/resource-registry";

// 0192 — WAIT-03B recipient-proof authority (B1 … B1.5c).
//
// SOURCE CONTRACT. This file proves what the migration SAYS. The behavioural
// half — that a bearer token really cannot redeem or decline, that the
// capability really expires on the server clock, that cross-invitation and
// cross-studio proof are really refused — lives in
// tests/db/waitlist-recipient-proof.db.test.ts and can only be demonstrated by
// PostgreSQL. Neither is sufficient alone: SQL text cannot prove a grant fires,
// and a behavioural test cannot prove a revoke line was WRITTEN rather than
// inherited from Supabase's create-time defaults — which is precisely the
// 0129/0164 failure class.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * re-introducing a bearer-only entry point — the bare-token decline, or a
//     re-grant of the ungated redeem_(text);
//   * giving the capability TTL back to the caller as an argument, which is how
//     a 31-minute capability becomes representable again;
//   * resurrecting the check-then-act oracle beside the gate;
//   * persisting a raw challenge or capability instead of its digest;
//   * granting any of this to anon or authenticated;
//   * dropping the recipient binding, so an edited entry silently retargets an
//     outstanding challenge.

const VERSION = "0192";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations", FILE),
  "utf8",
);

// The guard strips nothing for us, so anchor structural claims on CODE rather
// than on comment text — a comment quoting old code reads as live code to a
// naive grep, which is the 0190 verification trap.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0192 — identity and position", () => {
  it("is named for what it adds", () => {
    expect(FILE).toBe("0192_waitlist_recipient_proof_authority.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so a future migration
    // does not turn this file red. Whoever adds 0193 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("opens its own transaction and bounds the lock", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout/);
  });
});

describe("0192 — the round allowance is its own table, not a studios column", () => {
  it("creates studio_waitlist_admission_rounds with RLS enabled", () => {
    expect(CODE).toMatch(
      /create table if not exists public\.studio_waitlist_admission_rounds/,
    );
    expect(CODE).toMatch(
      /alter table public\.studio_waitlist_admission_rounds\s+enable row level security/,
    );
  });

  it("NEVER adds the allowance to public.studios", () => {
    // The whole reason this table exists: anon/authenticated hold TABLE-level
    // UPDATE on studios and a column-level revoke cannot remove it.
    expect(CODE).not.toMatch(/alter table public\.studios\s+add column/i);
  });

  it("revokes the round table from all four roles by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all on public.studio_waitlist_admission_rounds from ${role};`,
      );
    }
  });

  it("grants the browser a COLUMN select and no DML at all", () => {
    expect(CODE).toMatch(
      /grant select \(studio_id, allowance, updated_at\)\s*\n\s*on public\.studio_waitlist_admission_rounds to authenticated;/,
    );
    expect(CODE).not.toMatch(
      /grant (insert|update|delete)[^;]*on public\.studio_waitlist_admission_rounds/i,
    );
  });

  it("drops the policy before creating it, so re-apply cannot abort the file", () => {
    const drop = CODE.indexOf('drop policy if exists "studio_waitlist_admission_rounds_owner_select"');
    const create = CODE.indexOf('create policy "studio_waitlist_admission_rounds_owner_select"');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });
});

describe("0192 — a stored invitation cannot express a permission its owner did not grant", () => {
  it("scope is all-or-nothing", () => {
    expect(CODE).toMatch(/new_client_waitlist_invitations_scope_complete_check/);
    expect(CODE).toMatch(
      /scope_service_id is not null and scope_start_date is not null/,
    );
  });

  it("the scoped service must belong to the SAME studio (composite FK)", () => {
    expect(CODE).toMatch(
      /foreign key \(scope_service_id, studio_id\)\s*\n?\s*references public\.services \(id, studio_id\)/,
    );
  });

  it("an empty weekday array is refused, and NULL means every day", () => {
    expect(CODE).toMatch(/array_length\(scope_allowed_weekdays, 1\) between 1 and 7/);
    expect(CODE).toMatch(/scope_allowed_weekdays <@ array\[0,1,2,3,4,5,6\]::smallint\[\]/);
  });

  it("a declined invitation stops blocking the entry, and decline is terminal", () => {
    expect(CODE).toMatch(
      /create unique index if not exists new_client_waitlist_invitations_one_live_per_entry[\s\S]{0,240}declined_at is null/,
    );
    expect(CODE).toMatch(/new_client_waitlist_invitations_one_terminal_outcome_check/);
  });

  it("the no-repeat-declined key names EVERY offer-defining field, NULLS NOT DISTINCT", () => {
    // P3-2: omitting scope_allowed_weekdays collided two genuinely different
    // offers. NULLS NOT DISTINCT is required — the default would WEAKEN the
    // guard by making two identical all-days offers stop colliding.
    expect(CODE).toMatch(
      /new_client_waitlist_invitations_no_repeat_declined_offer[\s\S]{0,300}\(entry_id, scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays\)[\s\S]{0,60}nulls not distinct[\s\S]{0,60}where declined_at is not null/,
    );
  });
});

describe("0192 — NO PLAINTEXT PROOF IS EVER PERSISTED", () => {
  it("stores only sha256 hex digests, shape-checked", () => {
    expect(CODE).toMatch(/proof_challenge_hash\s+text/);
    expect(CODE).toMatch(/proof_capability_hash\s+text/);
    expect(CODE).toMatch(/new_client_waitlist_invitations_proof_hash_shape_check/);
    expect(CODE).toMatch(/proof_challenge_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
    expect(CODE).toMatch(/proof_capability_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  });

  it("adds NO STORED column that could hold a raw challenge or capability", () => {
    // A column named for the secret itself is the mutation this catches. Scope
    // this to PERSISTED columns only: `raw_challenge` and `raw_capability` are
    // legitimate RETURN values — the whole design is that they are handed to
    // the server exactly once and written nowhere.
    const added = [...CODE.matchAll(/add column if not exists\s+(\w+)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);
    for (const col of added) {
      expect(col, `${col} looks like it stores a raw credential`).not.toMatch(
        /^(raw_|.*_raw$|proof_challenge$|proof_capability$|.*_plaintext$|.*_secret$)/,
      );
    }
    // Every proof column that is persisted is a hash, an expiry or a counter.
    const proofCols = added.filter((c) => c.startsWith("proof_"));
    expect(proofCols.sort()).toEqual([
      "proof_capability_expires_at",
      "proof_capability_hash",
      "proof_challenge_attempts",
      "proof_challenge_expires_at",
      "proof_challenge_hash",
      "proof_challenge_sent_to_hash",
    ]);
  });

  it("every stored credential is paired with a server-clock expiry", () => {
    expect(CODE).toMatch(/new_client_waitlist_invitations_proof_pairing_check/);
    expect(CODE).toMatch(
      /\(proof_challenge_hash is null\) = \(proof_challenge_expires_at is null\)/,
    );
    expect(CODE).toMatch(
      /\(proof_capability_hash is null\) = \(proof_capability_expires_at is null\)/,
    );
  });

  it("the challenge is hashed before storage, never written raw", () => {
    expect(CODE).toMatch(
      /proof_challenge_hash\s+= encode\(extensions\.digest\(v_raw,'sha256'\),'hex'\)/,
    );
    expect(CODE).toMatch(
      /proof_capability_hash\s+= encode\(extensions\.digest\(v_cap,'sha256'\),'hex'\)/,
    );
  });
});

describe("0192 — the capability TTL is OWNED BY THE DATABASE", () => {
  it("complete_ takes NO ttl argument, so 31 minutes is unrepresentable", () => {
    expect(CODE).toMatch(
      /create or replace function public\.complete_waitlist_invitation_proof\(\s*p_raw_token\s+text,\s*p_raw_challenge text\s*\)/,
    );
    // The stale 3-argument signature must be dropped, never created.
    expect(CODE).toContain(
      "drop function if exists public.complete_waitlist_invitation_proof(text, text, integer);",
    );
    expect(CODE).not.toMatch(
      /create or replace function public\.complete_waitlist_invitation_proof\([^)]*integer/,
    );
  });

  it("anchors the capability at exactly 30 minutes on the post-lock server clock", () => {
    expect(CODE).toMatch(
      /proof_capability_expires_at = v_now \+ interval '30 minutes'/,
    );
    expect(CODE).toMatch(/v_now := clock_timestamp\(\)/);
    // No other interval may define the capability window.
    expect(CODE).not.toMatch(/proof_capability_expires_at\s*=\s*v_now \+ make_interval/);
  });

  it("the challenge TTL keeps its accepted 1..60 bound", () => {
    // B1.5c moved the CAPABILITY TTL to the database. It did not change the
    // caller-supplied CHALLENGE bound, so this must not silently tighten.
    expect(CODE).toMatch(
      /p_ttl_minutes is null or p_ttl_minutes <= 0 or p_ttl_minutes > 60/,
    );
  });
});

describe("0192 — the gate is INSIDE the mutation, and there is no way around it", () => {
  for (const fn of [
    "redeem_new_client_waitlist_invitation_verified",
    "decline_new_client_waitlist_invitation",
  ]) {
    it(`${fn} locks the row, then checks proof, then mutates`, () => {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      );
      const lock = body.indexOf("for update");
      const gate = body.indexOf("proof_required");
      const mutate = body.indexOf("update public.new_client_waitlist_invitations");
      expect(lock).toBeGreaterThan(-1);
      expect(gate).toBeGreaterThan(lock);
      expect(mutate).toBeGreaterThan(gate);
    });

    it(`${fn} refuses an expired or mismatched capability`, () => {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      );
      expect(body).toContain("proof_expired");
      expect(body).toContain("proof_invalid");
      expect(body).toMatch(/proof_capability_expires_at <= v_now/);
    });

    it(`${fn} burns the capability as it mutates, so it cannot be replayed`, () => {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      );
      expect(body).toMatch(
        /proof_capability_hash = null, proof_capability_expires_at = null/,
      );
    });
  }

  it("the BARE-TOKEN decline is dropped and never created", () => {
    expect(CODE).toContain(
      "drop function if exists public.decline_new_client_waitlist_invitation(text);",
    );
    // Only the two-argument form may exist.
    expect(CODE).not.toMatch(
      /create or replace function public\.decline_new_client_waitlist_invitation\(\s*p_raw_token\s+text\s*\)/,
    );
    expect(CODE).toMatch(
      /create or replace function public\.decline_new_client_waitlist_invitation\(\s*p_raw_token\s+text,\s*p_raw_capability text\s*\)/,
    );
  });

  it("the check-then-act oracle is dropped and never created", () => {
    expect(CODE).toContain(
      "drop function if exists public.validate_waitlist_invitation_proof(text, text);",
    );
    expect(CODE).not.toMatch(
      /create or replace function public\.validate_waitlist_invitation_proof/,
    );
  });

  it("the UNGATED applied redeem_(text) loses EXECUTE from all four roles", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from ${role};`,
      );
    }
    // ...and is never re-granted.
    expect(CODE).not.toMatch(
      /grant execute on function public\.redeem_new_client_waitlist_invitation\(text\)/,
    );
  });

  it("does not edit the frozen applied redeem_(text)", () => {
    expect(CODE).not.toMatch(
      /create or replace function public\.redeem_new_client_waitlist_invitation\(\s*p_raw_token\s+text\s*\)/,
    );
  });
});

describe("0192 — proof is bound to the STORED recipient, never to a browser-supplied one", () => {
  it("freezes the invited contact hash when the challenge is issued", () => {
    expect(CODE).toMatch(
      /proof_challenge_sent_to_hash = encode\(extensions\.digest\(lower\(btrim\(v_email\)\),'sha256'\),'hex'\)/,
    );
  });

  it("COMPARES that frozen hash on completion, and refuses a changed recipient", () => {
    // P1-2: begin_ wrote this column and nothing read it, so it advertised an
    // anti-retargeting control it did not provide.
    expect(CODE).toMatch(
      /r\.proof_challenge_sent_to_hash is distinct from v_live_hash/,
    );
    expect(CODE).toContain("recipient_changed");
  });

  it("reads the address from the ENTRY row, never from an argument", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
    );
    expect(body).toMatch(
      /from public\.new_client_waitlist_entries e\s*\n\s*where e\.id = r\.entry_id and e\.studio_id = r\.studio_id/,
    );
    // No email/contact argument exists to be trusted.
    expect(body.slice(0, body.indexOf("as $$"))).not.toMatch(/p_email|p_contact/);
  });
});

describe("0192 — a new challenge REPLACES the old, and kills any live capability", () => {
  it("begin_ overwrites the challenge and clears the capability in one statement", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.begin_waitlist_invitation_proof("),
    );
    expect(body).toMatch(/proof_challenge_attempts\s+= 0/);
    expect(body).toMatch(/proof_capability_hash\s+= null/);
    expect(body).toMatch(/proof_capability_expires_at\s+= null/);
  });

  it("completing a challenge CONSUMES it, so a verification cannot be replayed", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
    );
    expect(body).toMatch(/proof_challenge_hash\s+= null/);
    expect(body).toMatch(/proof_challenge_expires_at\s+= null/);
  });

  it("bounds wrong-challenge attempts", () => {
    expect(CODE).toMatch(/v_max constant integer := 5/);
    expect(CODE).toContain("too_many_attempts");
  });

  it("every proof command requires the invitation to still be LIVE", () => {
    for (const fn of [
      "begin_waitlist_invitation_proof",
      "complete_waitlist_invitation_proof",
      "redeem_new_client_waitlist_invitation_verified",
      "decline_new_client_waitlist_invitation",
    ]) {
      const body = CODE.slice(CODE.indexOf(`create or replace function public.${fn}(`));
      expect(body, `${fn} must fail closed when the invitation is not live`).toContain(
        "not_live",
      );
    }
  });
});

describe("0192 — the read-only resolver cannot consume an invitation", () => {
  it("is STABLE and contains no write statement", () => {
    const start = CODE.indexOf(
      "create or replace function public.resolve_new_client_waitlist_invitation(",
    );
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    expect(body).toMatch(/language sql\s*\n\s*stable/);
    expect(body).not.toMatch(/\b(update|insert|delete)\s+/i);
  });

  it("returns the recipient contact HASHED, never the raw address", () => {
    const start = CODE.indexOf(
      "create or replace function public.resolve_new_client_waitlist_invitation(",
    );
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    expect(body).toContain("recipient_contact_hash");
    expect(body).toMatch(
      /encode\(extensions\.digest\(lower\(btrim\(e\.email\)\), 'sha256'\), 'hex'\)/,
    );
  });
});

describe("0192 — privileges are enumerated by name, and nothing reaches the browser", () => {
  const FUNCTIONS = [
    "public.waitlist_admission_consumed(uuid)",
    "public.issue_scoped_new_client_waitlist_invitation(uuid, uuid, uuid, uuid, date, date, smallint[], integer)",
    "public.resolve_new_client_waitlist_invitation(text)",
    "public.begin_waitlist_invitation_proof(text, integer)",
    "public.complete_waitlist_invitation_proof(text, text)",
    "public.invalidate_waitlist_invitation_proof(uuid)",
    "public.redeem_new_client_waitlist_invitation_verified(text, text)",
    "public.decline_new_client_waitlist_invitation(text, text)",
  ];

  it("names every command in the revoke/grant loop", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at create time. Missing one by name is
    // the 0129 (anon) and 0164 (service_role) failure.
    for (const f of FUNCTIONS) {
      expect(CODE, `${f} must be in the privilege loop`).toContain(`'${f}'`);
    }
  });

  it("the loop revokes from all four roles and grants ONLY service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `execute format('revoke all privileges on function %s from ${role}', f);`,
      );
    }
    expect(CODE).toContain(
      "execute format('grant execute on function %s to service_role', f);",
    );
  });

  it("GRANTS NOTHING to anon or authenticated anywhere in the file", () => {
    const grants = CODE.match(/grant\s+execute[^;]*;/gi) ?? [];
    for (const g of grants) {
      expect(g).not.toMatch(/\banon\b/);
      expect(g).not.toMatch(/\bauthenticated\b/);
    }
  });

  it("every function pins search_path and the definer ones are marked", () => {
    const defs = CODE.match(/create or replace function public\.[\s\S]*?\$\$;/g) ?? [];
    expect(defs.length).toBe(8);
    for (const d of defs) {
      expect(d).toMatch(/set search_path = pg_catalog, pg_temp/);
    }
  });
});

describe("0192 — every table it creates has an EXPORT DISPOSITION on the record", () => {
  // WHY THIS LIVES HERE AND NOT ONLY IN tests/db.
  //
  // The export registry guard is real and it works — it is what caught this
  // omission. But it can only run in the db-integration lane, because it
  // introspects information_schema on a fully migrated stack. That lane is the
  // slowest one in CI, so a migration that adds a table and forgets its
  // disposition stays green through typecheck, lint, unit and the whole
  // migrations suite, and only goes red minutes later in db-integration.
  //
  // That is exactly how e038d1e8 was pushed red: the local run covered the
  // waitlist DB files and the full unit suite, and neither could see this.
  //
  // This assertion closes the loop in the FAST lane. It derives the table list
  // from the migration TEXT rather than hard-coding it, so a future table added
  // to this file is covered without anyone remembering to extend the test.
  const created = [
    ...CODE.matchAll(/create table if not exists\s+public\.(\w+)/g),
  ].map((m) => m[1]);

  it("creates at least one table, so this guard cannot pass vacuously", () => {
    expect(created.length).toBeGreaterThan(0);
    expect(created).toContain("studio_waitlist_admission_rounds");
  });

  it("every created table has a disposition — a missing one is a BUILD failure, not a discovery", () => {
    for (const table of created) {
      const disposition = EXPORT_RESOURCE_REGISTRY[table];
      expect(
        disposition,
        `${table} is created by 0192 but has no entry in EXPORT_RESOURCE_REGISTRY. ` +
          `Nothing is allowed to reach the database without someone deciding whether ` +
          `a departing studio gets it.`,
      ).toBeDefined();
      expect(["exported", "excluded", "pending"]).toContain(disposition.kind);
    }
  });

  it("the round table is PENDING, with a ticket and a tier — never silently EXPORTED or EXCLUDED", () => {
    const d = EXPORT_RESOURCE_REGISTRY["studio_waitlist_admission_rounds"];
    // PINS THE DISPOSITION. Promoting this table to `exported` is a payload
    // change and must be a deliberate, reviewed act; demoting it to `excluded`
    // would hide an owner's own admission decision from a departing studio.
    // Either would flip this assertion, which is the point.
    expect(d.kind).toBe("pending");
    if (d.kind !== "pending") throw new Error("unreachable: narrowed above");
    // A pending entry that carries no ticket is a gap kept quiet, which is the
    // exact failure the registry exists to prevent.
    expect(d.ticket).toBeTruthy();
    expect(d.tier).toBeTypeOf("number");
    expect(d.reason.length).toBeGreaterThan(80);
    // Not field-review-required, and that is a CLAIM about the row: three
    // columns, no security material, no provider identifier, no attribution.
    // If a later slice adds such a column here, this must be revisited.
    expect(d.fieldReviewRequired ?? false).toBe(false);
  });
});
