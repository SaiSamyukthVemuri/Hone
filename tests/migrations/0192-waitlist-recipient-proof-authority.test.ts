import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// isRepoMax / versionsAbove are deliberately NOT imported any more: the
// repo-max assertion moved to 0193 (see below), and leaving unused imports
// behind would fail lint.
import { fileForVersion } from "./helpers/migration-state";
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

  // THE REPO-MAX ASSERTION HAS MOVED TO 0193, which is the handoff this file's
  // previous comment asked for ("whoever adds 0193 moves it") and the rule
  // CLAUDE.md states: only the CURRENT maximum migration's own test may assert
  // isRepoMax, because otherwise every landing migration reds an older file and
  // the sweep gets missed. tests/migrations/0193-waitlist-admission-authority.test.ts
  // now carries it. Nothing else in this file changed: every behavioural and
  // security assertion 0192 makes about itself is untouched.

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
      /grant select \(\s*\n?\s*id, studio_id, allowance, opened_at, opened_by_practitioner_id,\s*\n?\s*closed_at, closed_by_practitioner_id, updated_at\s*\n?\s*\) on public\.studio_waitlist_admission_rounds to authenticated;/,
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
      // A non-secret handle for one challenge event. It is a uuid, not a
      // credential, and it is listed here so adding a SEVENTH proof column
      // stays a deliberate act.
      "proof_challenge_id",
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

describe("0192 — the gated recipient-identity read", () => {
  // 0185 revoked EVERY table privilege on new_client_waitlist_entries from
  // service_role by name, so the server cannot read a recipient's contact
  // details directly. B3 still has to submit them to book. This command is the
  // only bridge, and these assertions pin that it is a NARROW one.
  const SIG = "create or replace function public.resolve_waitlist_invitation_recipient_identity(";
  const body = () => {
    const start = CODE.indexOf(SIG);
    expect(start, "the identity command must exist").toBeGreaterThan(-1);
    return CODE.slice(start, CODE.indexOf("$$;", start));
  };

  it("is CAPABILITY-GATED — there is no bare-token signature", () => {
    // A one-argument variant would be a bearer path to contact details, which
    // is the whole thing 0185's revoke and this slice's two-authority law
    // exist to prevent.
    expect(body()).toContain("p_raw_capability text");
    expect(CODE).not.toMatch(
      /create or replace function public\.resolve_waitlist_invitation_recipient_identity\(\s*p_raw_token\s+text\s*\)/,
    );
  });

  it("returns ONLY a result and the three booking fields", () => {
    // The named mutation: widening this return list. No lifecycle column, no
    // proof or recipient hash, no scope and no identifier may join it.
    expect(body()).toContain("returns table (result text, name text, email text, phone text)");
    for (const leak of [
      "proof_challenge_sent_to_hash",
      "recipient_contact_hash",
      "token_hash",
      "scope_service_id",
      "redeemed_at,",
      "entry_id,",
    ]) {
      expect(
        body().split("returns table")[1].split(")")[0],
        `${leak} must not be in the return list`,
      ).not.toContain(leak);
    }
  });

  it("applies the SAME capability test as the gated mutations, not a softer one", () => {
    const b = body();
    // Identical vocabulary and identical order to redeem_ and decline_.
    expect(b).toContain("if r.proof_capability_hash is null then");
    expect(b).toContain("'proof_required'");
    expect(b).toContain("if r.proof_capability_expires_at <= v_now then");
    expect(b).toContain("'proof_expired'");
    expect(b).toMatch(
      /r\.proof_capability_hash <> encode\(extensions\.digest\(p_raw_capability,'sha256'\),'hex'\)/,
    );
    expect(b).toContain("'proof_invalid'");
    // Liveness is the full set, including decline.
    expect(b).toMatch(
      /r\.redeemed_at is not null or r\.expired_at is not null[\s\S]*?r\.released_at is not null or r\.declined_at is not null[\s\S]*?r\.expires_at <= v_now/,
    );
    expect(b).toContain("'not_live'");
    // Post-lock clock, as 0189 established.
    expect(b).toContain("v_now := clock_timestamp();");
  });

  it("pins the invitation for the whole decision and does NOT lock the entry", () => {
    const b = body();
    expect(b).toContain("for update");
    // decline_, release_ and expire_ all take the ENTRY mutex first. A second
    // order over the same pair is the deadlock cycle the decline P2 removed,
    // so the entry is read WITHOUT a lock here.
    expect(b).not.toMatch(/from public\.new_client_waitlist_entries e[\s\S]*?for update/);
  });

  it("reads identity only from THIS invitation's entry, in THIS studio", () => {
    expect(body()).toMatch(/where e\.id = r\.entry_id and e\.studio_id = r\.studio_id/);
  });

  it("writes nothing", () => {
    const b = body();
    for (const w of ["update public.", "insert into public.", "delete from public."]) {
      expect(b, `the identity read must not ${w.trim()}`).not.toContain(w);
    }
  });

  it("adds NO table privilege on the entries table — 0185's revoke stands", () => {
    // The forbidden repair. Granting service_role SELECT here would reverse an
    // explicit privacy boundary and make every other assertion cosmetic.
    expect(CODE).not.toMatch(/grant[^;]*\bon\b[^;]*public\.new_client_waitlist_entries/i);
  });
});

describe("0192 — privileges are enumerated by name, and nothing reaches the browser", () => {
  const FUNCTIONS = [
    "public.waitlist_admission_round_consumed(uuid)",
    "public.open_new_client_waitlist_admission_round(uuid, uuid, integer)",
    "public.close_new_client_waitlist_admission_round(uuid, uuid)",
    "public.issue_scoped_new_client_waitlist_invitation(uuid, uuid, uuid, uuid, date, date, smallint[], integer)",
    "public.resolve_new_client_waitlist_invitation(text)",
    "public.begin_waitlist_invitation_proof(text, integer)",
    "public.complete_waitlist_invitation_proof(text, text)",
    "public.invalidate_waitlist_invitation_proof(uuid)",
    "public.redeem_new_client_waitlist_invitation_verified(text, text)",
    "public.decline_new_client_waitlist_invitation(text, text)",
    "public.resolve_waitlist_invitation_recipient_identity(text, text)",
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
    // NINE new commands, plus FOUR forward REDEFINITIONS of already-applied
    // functions. 0188/0189/0190 stay frozen; a function whose meaning changed
    // when declined_at arrived is re-created here instead.
    //
    //   1 delegated issuer            — the first repair in this family (§4b)
    //   3 legacy lifecycle commands   — expire_, release_, record_conversion
    //                                   (§14b, the class-wide completion)
    //   1 invitation append-only guard — so a round binding is immutable (§14c)
    //
    // Plus TWO new round-authority commands (§14d), open_ and close_, which
    // replace the raw service-role upsert that was previously the only way to
    // establish a round.
    //
    // The ninth original command is the gated recipient-identity read the
    // integration lane proved B3 could not book without.
    expect(defs.length).toBe(16);
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

describe("0192 — exact-head review repairs (9c25e0fb)", () => {
  it("P1: the LEGACY unscoped issuer loses EXECUTE from all four roles", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all privileges on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from ${role};`,
      );
    }
    // ...and is never re-granted.
    expect(CODE).not.toMatch(
      /grant execute on function public\.issue_new_client_waitlist_invitation\(uuid, uuid, uuid, integer\)/,
    );
  });

  it("P1: the issuer is REDEFINED so a declined invitation is closed", () => {
    // 0190's file is frozen; this is a forward create-or-replace, the same
    // mechanism 0189 and 0190 each used on this function.
    const start = CODE.indexOf(
      "create or replace function public.issue_new_client_waitlist_invitation(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    expect(body).toMatch(
      /i\.redeemed_at is null and i\.expired_at is null and i\.released_at is null\s*\n\s*and i\.declined_at is null/,
    );
    // The TTL anchor 0190 exists to fix must survive the redefinition.
    expect(body).toMatch(/v_decision_at := clock_timestamp\(\)/);
    expect(body).toMatch(/v_expires := v_decision_at \+ make_interval\(hours => v_ttl\)/);
    expect(body).not.toMatch(/now\(\) \+ make_interval/);
  });

  it("P1: the no-repeat-SAME-declined-offer rule is enforced at ISSUE, with a code", () => {
    // The partial index only fires on a SECOND declined row, so after the
    // repair the identical offer could be re-issued and the second decline
    // died on a bare 23505. A command here returns a code, never raises.
    expect(CODE).toContain("already_declined_offer");
    expect(CODE).toMatch(/i\.scope_allowed_weekdays is not distinct from p_allowed_weekdays/);
    // ...and it is still keyed on the FULL offer, so a different offer passes.
    for (const col of [
      "scope_service_id",
      "scope_start_date",
      "scope_end_date",
      "scope_allowed_weekdays",
    ]) {
      expect(CODE).toMatch(new RegExp(`i\\.${col}\\s+is not distinct from`));
    }
  });

  it("P2: decline takes the ENTRY lock before the invitation lock", () => {
    const start = CODE.indexOf(
      "create or replace function public.decline_new_client_waitlist_invitation(",
    );
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    const entryLock = body.indexOf("from public.new_client_waitlist_entries e");
    const invLock = body.indexOf("where i.id = v_inv");
    expect(entryLock).toBeGreaterThan(-1);
    expect(invLock).toBeGreaterThan(entryLock);
    // Proof validation still happens AFTER both locks, in the same transaction.
    expect(body.indexOf("proof_required")).toBeGreaterThan(invLock);
  });
});

describe("0192 — the challenge event id is a handle, not a credential", () => {
  it("adds proof_challenge_id and binds it into the pairing rule", () => {
    expect(CODE).toMatch(/add column if not exists proof_challenge_id\s+uuid/);
    expect(CODE).toMatch(
      /\(proof_challenge_hash is null\) = \(proof_challenge_id is null\)/,
    );
  });

  it("begin_ mints it independently of the secret and RETURNS it", () => {
    expect(CODE).toMatch(/v_cid := gen_random_uuid\(\)/);
    // Declared in the return table. The closing paren is no longer adjacent:
    // the shape gained `issued_at` for the delivery contract.
    expect(CODE).toMatch(/challenge_id\s+uuid/);
    // NOT derived from the raw challenge — that is the #680 defect class.
    expect(CODE).not.toMatch(/v_cid\s*:=[^;]*v_raw/);
    expect(CODE).not.toMatch(/proof_challenge_id\s*=\s*encode\(/);
  });

  it("is cleared when the challenge is consumed and by invalidate_", () => {
    const complete = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
    );
    expect(complete).toMatch(/proof_challenge_id\s+= null/);
    const inval = CODE.slice(
      CODE.indexOf("create or replace function public.invalidate_waitlist_invitation_proof("),
    );
    expect(inval).toMatch(/proof_challenge_id = null/);
  });

  it("is never granted to a browser role", () => {
    // 0188's grant is a positive list; this column must not be added to it.
    expect(CODE).not.toMatch(/grant select[^;]*proof_challenge_id/);
  });
});

// WAIT DELIVERY-01 contract delta — the SOURCE half.
//
// A behavioural test can show that `issued_at` looks like the mint instant. Only
// the text can show it IS the one the expiry was computed from, rather than a
// second `clock_timestamp()` that would agree on a fast machine and diverge on a
// slow one. That distinction is exactly what this file exists for.
describe("0192 — begin_ returns the authoritative mint instant", () => {
  const BEGIN = CODE.slice(
    CODE.indexOf("create or replace function public.begin_waitlist_invitation_proof("),
    CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
  );

  it("declares issued_at in the return table", () => {
    expect(BEGIN).toMatch(/issued_at\s+timestamptz/);
  });

  it("takes NO new argument — the instant is the database's, not the caller's", () => {
    const args = BEGIN.slice(0, BEGIN.indexOf("returns table"));
    expect(args).toContain("p_raw_token");
    expect(args).toContain("p_ttl_minutes");
    // Nothing resembling a caller-supplied clock.
    expect(args).not.toMatch(/issued|now|timestamp|clock/i);
  });

  it("returns the SAME v_now the expiry is computed from, not a second reading", () => {
    // One assignment only. A second `clock_timestamp()` inside this command
    // would be a different instant, and `expires_at - issued_at` would stop
    // being exactly the TTL.
    const assignments = BEGIN.match(/v_now\s*:=\s*clock_timestamp\(\)/g) ?? [];
    expect(assignments.length).toBe(1);
    expect(BEGIN).toMatch(/return query select 'challenge_issued'[\s\S]*?v_cid,\s*v_now;/);
  });

  it("reads that clock AFTER the row lock", () => {
    const lockAt = BEGIN.indexOf("for update");
    const clockAt = BEGIN.indexOf("v_now := clock_timestamp()");
    expect(lockAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(lockAt);
  });

  it("hands the instant back ONLY on challenge_issued", () => {
    for (const code of ["invalid_input", "invalid_token", "not_live"]) {
      const line = BEGIN.split("\n").find((l) => l.includes(`'${code}'::text`));
      expect(line, `${code} must exist`).toBeTruthy();
      // Six columns, and the last one null: the refusal carries no instant.
      expect(line as string).toMatch(/null::uuid,\s*null::timestamptz/);
    }
  });

  it("stores no new column for it — the instant is returned, not remembered", () => {
    // The delta must not have added a column to carry this.
    expect(CODE).not.toMatch(/add column if not exists\s+proof_challenge_issued_at/);
    expect(CODE).not.toMatch(/proof_challenge_issued_at/);
  });

  it("leaves the challenge TTL bound and the capability TTL alone", () => {
    // Challenge: caller-chosen within 1..60. Capability: database-owned 30.
    expect(BEGIN).toMatch(/p_ttl_minutes\s*<=\s*0\s*or\s*p_ttl_minutes\s*>\s*60/);
    const COMPLETE = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
    );
    expect(COMPLETE).toContain("interval '30 minutes'");
    expect(COMPLETE).not.toContain("p_ttl_minutes");
  });

  it("still drops the prior signature, because a return shape cannot change in place", () => {
    expect(CODE).toContain(
      "drop function if exists public.begin_waitlist_invitation_proof(text, integer);",
    );
  });

  it("still persists only the HASH of the challenge, never the raw secret", () => {
    expect(BEGIN).toMatch(/proof_challenge_hash\s+= encode\(extensions\.digest\(v_raw/);
    // v_raw is returned to the caller and written nowhere in plaintext.
    expect(BEGIN).not.toMatch(/set[\s\S]*?=\s*v_raw\b/);
  });
});

describe("0192 — the challenge clock is bounded by the invitation clock", () => {
  const BEGIN = CODE.slice(
    CODE.indexOf("create or replace function public.begin_waitlist_invitation_proof("),
    CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
  );

  it("reads the invitation's own expiry from the LOCKED row, in the locking statement", () => {
    // Not a second SELECT afterwards, and not a caller argument: the authority
    // for when this invitation dies is the row this transaction holds.
    const lockingSelect = BEGIN.slice(
      BEGIN.indexOf("select i.id, i.entry_id, i.studio_id"),
      BEGIN.indexOf("for update") + "for update".length,
    );
    expect(lockingSelect).toContain("i.expires_at");
    expect(lockingSelect).toContain("v_inv_expires");
  });

  it("clamps the persisted expiry to the invitation, and computes it once", () => {
    expect(BEGIN).toMatch(
      /v_challenge_expires\s*:=\s*least\(\s*v_now \+ make_interval\(mins => p_ttl_minutes\),\s*v_inv_expires\s*\)/,
    );
    const assignments = BEGIN.match(/v_challenge_expires\s*:=/g) ?? [];
    expect(assignments.length, "one computation, or the two writes can disagree").toBe(1);
  });

  it("PERSISTS and RETURNS that one variable — never a recomputation", () => {
    expect(BEGIN).toMatch(/proof_challenge_expires_at\s*=\s*v_challenge_expires,/);
    expect(BEGIN).toMatch(
      /return query select 'challenge_issued'[\s\S]*?v_challenge_expires,\s*v_cid,\s*v_now;/,
    );
    // THE DEFECT SHAPE ITSELF, named so it cannot come back by edit: the raw
    // requested window must appear nowhere as a stored or returned expiry.
    expect(BEGIN).not.toMatch(
      /proof_challenge_expires_at\s*=\s*v_now \+ make_interval\(mins => p_ttl_minutes\)/,
    );
    const unclamped = BEGIN.match(/v_now \+ make_interval\(mins => p_ttl_minutes\)/g) ?? [];
    expect(
      unclamped.length,
      "the requested window may appear ONLY as the left operand of the clamp",
    ).toBe(1);
  });

  it("clamps AFTER the liveness gate, so the result is never already expired", () => {
    // The gate establishes expires_at > v_now; only then is `least` guaranteed
    // to return an instant strictly in the future. Ordering is the proof that
    // no new near-expiry refusal word was needed.
    const gateAt = BEGIN.indexOf("'not_live'::text");
    const clampAt = BEGIN.indexOf("v_challenge_expires :=");
    expect(gateAt).toBeGreaterThan(-1);
    expect(clampAt).toBeGreaterThan(gateAt);
  });

  it("adds NO new result word — the vocabulary is unchanged", () => {
    const words = new Set(
      (BEGIN.match(/'([a-z_]+)'::text/g) ?? []).map((m) => m.slice(1, m.indexOf("'", 1))),
    );
    expect([...words].sort()).toEqual([
      "challenge_issued",
      "invalid_input",
      "invalid_token",
      "not_live",
    ]);
  });

  it("leaves the capability's database-owned 30 minutes alone", () => {
    const COMPLETE = CODE.slice(
      CODE.indexOf("create or replace function public.complete_waitlist_invitation_proof("),
      CODE.indexOf("create or replace function public.invalidate_waitlist_invitation_proof("),
    );
    expect(COMPLETE).toContain("proof_capability_expires_at = v_now + interval '30 minutes'");
    expect(COMPLETE).not.toContain("v_challenge_expires");
    expect(COMPLETE).not.toContain("least(");
  });
});

describe("0192 §14b — the legacy lifecycle commands are declined-aware", () => {
  // A NAMED-AUTHORITY REGRESSION GUARD, deliberately not a SQL parser.
  //
  // It knows exactly three functions by name — the three the class census
  // identified — and asks one question of each: does every three-terminal
  // invitation predicate in its body also require `declined_at is null`?
  //
  // Scoped this narrowly on purpose. A general scan over arbitrary migrations
  // would flag 0188/0189/0190, whose bytes are APPLIED AND FROZEN and whose
  // three-terminal predicates were correct when written — they are superseded
  // here, not wrong there. The guard protects the forward definitions that are
  // now authoritative, and nothing else.
  const OWNED = [
    "expire_new_client_waitlist_invitation",
    "release_new_client_waitlist_entry",
    "record_new_client_waitlist_conversion",
  ] as const;

  const bodyOf = (fn: string): string => {
    const start = CODE.indexOf(`create or replace function public.${fn}(`);
    expect(start, `${fn} must be forward-redefined in 0192`).toBeGreaterThan(-1);
    const end = CODE.indexOf("\n$$;", start);
    expect(end, `${fn} must terminate`).toBeGreaterThan(start);
    return CODE.slice(start, end);
  };

  it.each(OWNED)("%s is redefined here, so 0189's version is superseded", (fn) => {
    expect(CODE).toContain(`create or replace function public.${fn}(`);
  });

  // -------------------------------------------------------------------------
  // SOURCE PRESENCE IS A SECOND OPINION.
  // POSTGRESQL BEHAVIOURAL TESTS OWN SEMANTIC DECLINED-ROW EXCLUSION.
  //
  // THIS GUARD USED TO CLAIM MORE THAN A TEXT MATCHER CAN HONESTLY PROVE, and
  // it was wrong four times in a row, each time in a way that looked correct:
  //
  //   1. counting tokens proved PRESENCE, not RELATIONSHIP — `and` -> `or` kept
  //      the counts equal while inverting the predicate;
  //   2. checking the gaps between four terms proved only INTERNAL conjunction,
  //      and said nothing about how the group attaches to what surrounds it;
  //   3. so a disjunction at either BOUNDARY of the group still passed;
  //   4. and inline `--` comments inside a statement survived the matcher.
  //
  // Every repair required understanding a little more SQL: operator precedence,
  // parentheses, comment syntax. That road ends at reimplementing a SQL parser
  // inside a Vitest source test, which is out of scope and would itself need
  // proving. PostgreSQL already knows SQL semantics.
  //
  // SO THE SEMANTIC CLAIM IS RETIRED HERE AND MOVED TO THE DATABASE. The
  // load-bearing proof is the LOCK-TARGET fixture in
  // tests/db/waitlist-recipient-proof.db.test.ts: a historical declined row is
  // held under `for update` by a second connection, and each lifecycle command
  // is called with a short `statement_timeout`. A command that still SELECTS
  // that row as the current cycle MUST try to lock it and MUST time out with
  // 57014. No physical row ordering, comment placement or operator precedence
  // can hide that.
  //
  // Its claim is bounded to SELECTION, LOCKING and TERMINAL MUTATION. It does
  // not assert the declined row is never read — `expire_` legitimately scans
  // this table in `exists (...)` subqueries that touch it without matching or
  // locking it.
  //
  // WHAT REMAINS BELOW IS ONLY WHAT TEXT CAN HONESTLY ESTABLISH: that these
  // three functions are forward-redefined here at all, with their signatures,
  // definer posture, pinned search_path and explicit privileges intact, and
  // that no chronology-based "repair" was smuggled in. Presence of `declined_at`
  // is asserted as corroboration — deliberately NOT as proof of liveness
  // semantics, which this layer cannot and no longer pretends to decide.
  // -------------------------------------------------------------------------

  it.each(OWNED)("%s mentions declined_at — corroboration only, never proof", (fn) => {
    // A necessary condition, not a sufficient one. If this fails the repair is
    // certainly gone; if it passes, the DB lock-target tests are what decide.
    expect(bodyOf(fn)).toContain("declined_at");
  });

  it.each(OWNED)("%s keeps its exact signature and definer posture", (fn) => {
    const body = bodyOf(fn);
    expect(body).toMatch(/\(\s*\n\s*p_studio_id\s+uuid,/);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = pg_catalog, pg_temp");
  });

  it.each(OWNED)("%s is re-granted to service_role ONLY, by name", (fn) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all privileges on function public.${fn}(uuid, uuid, uuid) from ${role};`,
      );
    }
    expect(CODE).toContain(
      `grant  execute on function public.${fn}(uuid, uuid, uuid) to service_role;`,
    );
    expect(CODE).not.toContain(
      `grant  execute on function public.${fn}(uuid, uuid, uuid) to authenticated;`,
    );
    expect(CODE).not.toContain(
      `grant  execute on function public.${fn}(uuid, uuid, uuid) to anon;`,
    );
  });

  it("CHRONOLOGY IS NOT THE REPAIR: no ordering was smuggled into the selectors", () => {
    // An `order by issued_at desc limit 1` would also make the ambiguous select
    // single-valued, and would be WRONG — it picks by age rather than liveness
    // and still acts on a declined row when that row is newest. The invariant is
    // the four-terminal predicate.
    for (const fn of OWNED) {
      const body = bodyOf(fn);
      expect(body, `${fn} must not order the invitation selector`).not.toMatch(
        /order by[\s\S]{0,40}issued_at/,
      );
    }
  });

  it("the frozen migrations are NOT edited — this is a forward redefinition", () => {
    // 0188/0189/0190 are applied. The repair may only add a later definition.
    for (const older of ["0188", "0189", "0190"]) {
      const p = path.resolve(__dirname, "../../supabase/migrations");
      const file = readdirSync(p).find((f) => f.startsWith(`${older}_`));
      expect(file, `${older} must still exist`).toBeTruthy();
    }
  });
});
