import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
  migrationState,
} from "./helpers/migration-state";

// 0191 — COMMS-01B: per-studio SMS sender, and the claim that makes buying one safe.
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that the partial unique index actually excludes a second
// live row, that the trigger actually refuses a reminted claim key, that the
// readiness CHECK actually blocks `active` — lives in
// tests/db/studio-sms-sender.db.test.ts and can only be demonstrated by
// PostgreSQL. Neither is sufficient alone: SQL text cannot prove a constraint
// fires, and a behavioural test cannot prove a grant line was WRITTEN rather
// than inherited from Supabase's create-time defaults.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * edit an APPLIED migration instead of adding 0191 -> the position
//     assertions fail;
//   * let the claim key be rewritten -> the write-once assertions fail, and
//     with them the only thing stopping a retry buying a second number;
//   * allow `error -> off` -> the reset-is-forbidden assertion fails, which is
//     the other way a retry loses its handle on a purchased number;
//   * hand a live claim's key to a second request -> the exclusion assertions
//     fail, and two concurrent submits both purchase;
//   * drop a limb from the readiness CHECK -> an unproven sender can go live;
//   * grant the browser a provider identifier -> the column-grant assertions
//     fail;
//   * revoke by name and forget a role -> the privilege assertions fail, which
//     is the 0129 / 0164 failure class;
//   * make a command SECURITY INVOKER or drop its search_path pin.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0191";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's header
// discusses the very constructs it forbids (a second purchase, a reset to
// `off`), so every "does not contain" assertion runs against comment-stripped
// SQL.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The migration's own statements, with function bodies removed. */
const OUTSIDE_FUNCTIONS = CODE.replace(
  /create or replace function[\s\S]*?\$\$;/g,
  "",
);

/** The executable body of one function, comment-stripped. */
function body(fn: string): string {
  const at = CODE.indexOf(`create or replace function public.${fn}`);
  expect(at, `${fn} is not defined in ${FILE}`).toBeGreaterThan(-1);
  const end = CODE.indexOf("$$;", at);
  expect(end, `${fn} has no terminator`).toBeGreaterThan(at);
  return CODE.slice(at, end);
}

const TABLE = "studio_sms_senders";
const CLAIM = "claim_studio_sms_provisioning";
const FINALIZE = "finalize_studio_sms_provisioning";
const FAIL = "fail_studio_sms_provisioning";
const RESOLVE = "resolve_studio_by_sms_messaging_service";
const GUARD = "studio_sms_senders_transition_guard";
const STAMPS = "studio_sms_senders_server_timestamps";

const COMMANDS = [CLAIM, FINALIZE, FAIL, RESOLVE] as const;

// ---------------------------------------------------------------------------
// 1. Identity and position
// ---------------------------------------------------------------------------

describe("0191 — identity and position", () => {
  it("is named for what it adds", () => {
    expect(FILE).toBe("0191_studio_sms_sender_provisioning.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so that a future
    // migration does not turn this file red. Whoever adds 0192 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is NOT applied to production, and does not claim to be", () => {
    // COMMS-01B builds the model; applying it is a separate, separately
    // authorized act. The hosted head is whatever the canonical record says,
    // and it is not this file.
    const state = migrationState();
    expect(state.hosted_migration_max_number).toBeLessThan(191);
    expect(state.pending_migrations).toContain(VERSION);
  });

  it("edits no applied migration", () => {
    // The whole file is new. Nothing here reaches back into a frozen file.
    expect(CODE).not.toMatch(/0(1[0-8][0-9]|19[0])_/);
  });
});

// ---------------------------------------------------------------------------
// 2. Transaction envelope
// ---------------------------------------------------------------------------

describe("transaction envelope", () => {
  it("opens its own transaction and arms a lock timeout inside it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    const commit = CODE.lastIndexOf("commit;");
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });

  it("commits exactly once and never rolls back mid-file", () => {
    expect(CODE.match(/^\s*begin;/gm) ?? []).toHaveLength(1);
    expect(CODE.match(/^\s*commit;/gm) ?? []).toHaveLength(1);
    expect(CODE).not.toMatch(/^\s*rollback/gm);
  });
});

// ---------------------------------------------------------------------------
// 3. Additive only
// ---------------------------------------------------------------------------

describe("the change is additive", () => {
  it("creates its table and alters no pre-existing one", () => {
    expect(OUTSIDE_FUNCTIONS).toContain(`create table if not exists public.${TABLE}`);
    // Every ALTER TABLE in the file targets the new table.
    const alters = [...OUTSIDE_FUNCTIONS.matchAll(/alter table (\S+)/g)].map((m) => m[1]);
    expect(alters.length).toBeGreaterThan(0);
    for (const target of alters) expect(target).toBe(`public.${TABLE}`);
  });

  it("drops nothing that exists outside this file", () => {
    // The drop-if-exists-then-add idiom is used for THIS table's own
    // constraints, triggers and policies, which is idempotency, not removal.
    expect(OUTSIDE_FUNCTIONS).not.toMatch(/drop table/i);
    expect(OUTSIDE_FUNCTIONS).not.toMatch(/drop column/i);
    expect(OUTSIDE_FUNCTIONS).not.toMatch(/drop function/i);
    const drops = [...OUTSIDE_FUNCTIONS.matchAll(/drop (trigger|policy) if exists\s+"?([^\s"]+)"?/g)];
    expect(drops.length).toBeGreaterThan(0);
    for (const [, , name] of drops) expect(name).toContain(TABLE);
  });

  it("does not touch studios, clients, appointments or any send path", () => {
    // SMS enablement authority stays exactly where 0049 put it.
    for (const t of ["public.studios", "public.clients", "public.appointments"]) {
      expect(OUTSIDE_FUNCTIONS).not.toMatch(new RegExp(`alter table ${t.replace(".", "\\.")}`));
    }
    expect(CODE).not.toContain("send_confirmation_sms");
    expect(CODE).not.toContain("send_24h_sms_reminders");
    expect(CODE).not.toContain("send_2h_sms_reminders");
    expect(CODE).not.toContain("sms_opted_out_at");
    expect(CODE).not.toContain("claim_sms_send");
    expect(CODE).not.toContain("record_sms_result");
  });

  it("fabricates no active sender and seeds no row", () => {
    // The only INSERT is inside the claim command, which an owner must invoke.
    expect(OUTSIDE_FUNCTIONS).not.toMatch(/insert into/i);
    expect(body(CLAIM)).toMatch(/insert into public\.studio_sms_senders/);
    expect(body(CLAIM)).toContain("'provisioning'");
  });

  it("stores no credential of any kind", () => {
    // Scanned over the COLUMN DEFINITIONS, not the whole file: the table
    // comment legitimately contains the phrase "NO CREDENTIALS ARE STORED PER
    // STUDIO", and a test that banned the word outright would ban saying so.
    const columns = CODE.slice(
      CODE.indexOf(`create table if not exists public.${TABLE}`),
      CODE.indexOf(");", CODE.indexOf(`create table if not exists public.${TABLE}`)),
    );
    expect(columns).toBeTruthy();
    for (const forbidden of [
      "auth_token", "authtoken", "api_key", "apikey",
      "secret", "password", "credential", "token",
    ]) {
      expect(columns.toLowerCase()).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Tenancy
// ---------------------------------------------------------------------------

describe("tenancy", () => {
  it("is studio-scoped and cascades with the studio", () => {
    expect(CODE).toMatch(/studio_id uuid not null\s*\n\s*references public\.studios\(id\) on delete cascade/);
  });

  it("attributes the claim through a same-studio composite FK (0179 doctrine)", () => {
    expect(CODE).toMatch(
      /foreign key \(provisioning_claim_by_practitioner_id, studio_id\)\s*\n\s*references public\.practitioners \(id, studio_id\)/,
    );
  });

  it("enables RLS and exposes rows only to that studio's owner", () => {
    expect(CODE).toContain(`alter table public.${TABLE} enable row level security`);
    expect(CODE).toMatch(
      new RegExp(`create policy "${TABLE}_owner_select"[\\s\\S]*?using \\(public\\.is_studio_owner\\(${TABLE}\\.studio_id\\)\\)`),
    );
  });

  it("has no INSERT, UPDATE or DELETE policy at all", () => {
    // Every write goes through a definer command that re-derives authority.
    // Scanned outside function bodies so the row-lock `for update` inside a
    // command is not mistaken for a policy.
    const policies = [...OUTSIDE_FUNCTIONS.matchAll(/create policy[\s\S]*?for (\w+)/g)];
    expect(policies.length).toBeGreaterThan(0);
    for (const [, verb] of policies) expect(verb.toLowerCase()).toBe("select");
  });

  it("resolves a provider callback by unique key, not by scanning tenant state", () => {
    const resolve = body(RESOLVE);
    expect(resolve).toContain("where s.messaging_service_sid = p_messaging_service_sid");
    expect(CODE).toContain(`create unique index if not exists ${TABLE}_messaging_service_sid_unique`);
    // It never reads clients, appointments or studios to attribute a callback.
    expect(resolve).not.toContain("public.clients");
    expect(resolve).not.toContain("public.studios");
  });
});

// ---------------------------------------------------------------------------
// 5. THE IDEMPOTENCY INVARIANTS
// ---------------------------------------------------------------------------

describe("INVARIANT 1 — one live sender per studio", () => {
  it("is a partial unique index over every non-released status", () => {
    expect(CODE).toMatch(
      new RegExp(
        `create unique index if not exists ${TABLE}_one_live_per_studio\\s*\\n\\s*on public\\.${TABLE} \\(studio_id\\)\\s*\\n\\s*where status <> 'released'`,
      ),
    );
  });

  it("one provider resource can belong to only one studio", () => {
    for (const col of ["phone_number_sid", "messaging_service_sid", "phone_number"]) {
      expect(CODE).toMatch(
        new RegExp(`create unique index if not exists ${TABLE}_${col}_unique[\\s\\S]{0,200}?where ${col} is not null`),
      );
    }
  });
});

describe("INVARIANT 2 — the claim key is write-once", () => {
  it("the guard refuses any change to a claim key already set", () => {
    const guard = body(GUARD);
    expect(guard).toMatch(
      /old\.provisioning_claim_key is not null\s*\n\s*and new\.provisioning_claim_key is distinct from old\.provisioning_claim_key/,
    );
    expect(guard).toContain("write-once");
  });

  it("the key is globally unique, so it stays an unambiguous provider handle", () => {
    expect(CODE).toMatch(
      new RegExp(`create unique index if not exists ${TABLE}_claim_key_unique[\\s\\S]{0,200}?where provisioning_claim_key is not null`),
    );
  });

  it("the key is minted by the database, never accepted from a caller", () => {
    // Not a parameter of any command.
    expect(CODE).not.toMatch(/p_claim_key\s+text\s*\n?\s*\)?\s*,?\s*$[\s\S]{0,80}?insert into/m);
    expect(body(CLAIM)).toContain("'hone-sms-' || replace(gen_random_uuid()::text, '-', '')");
    // And CLAIM takes no key parameter at all.
    const signature = CODE.slice(
      CODE.indexOf(`create or replace function public.${CLAIM}`),
      CODE.indexOf("returns table", CODE.indexOf(`create or replace function public.${CLAIM}`)),
    );
    expect(signature).not.toContain("p_claim_key");
  });

  it("a shape CHECK keeps anything but a minted key out of the column", () => {
    expect(CODE).toMatch(/provisioning_claim_key ~ '\^hone-sms-\[0-9a-f\]\{32\}\$'/);
  });

  it("the LEASE may move forward but never backward", () => {
    // Split deliberately from the key: the key is identity and never moves;
    // the lease is liveness and must be refreshable or a crash wedges the studio.
    const guard = body(GUARD);
    expect(guard).toMatch(/new\.provisioning_claim_at < old\.provisioning_claim_at/);
    expect(guard).toContain("forward only");
  });
});

describe("INVARIANT 3 — a failed attempt is never reset", () => {
  it("error may retry or release, but never returns to off", () => {
    const guard = body(GUARD);
    const errorRow = guard.match(/old\.status = 'error'\s+and new\.status in \(([^)]*)\)/);
    expect(errorRow, "the error transition row is missing").not.toBeNull();
    const allowed = errorRow![1];
    expect(allowed).toContain("'provisioning'");
    expect(allowed).toContain("'releasing'");
    // THE ASSERTION: reset is the gesture that abandons a purchased number.
    expect(allowed).not.toContain("'off'");
  });

  it("released is terminal history and is never rewritten", () => {
    const guard = body(GUARD);
    expect(guard).toMatch(/old\.status = 'released'[\s\S]{0,200}?raise exception/);
  });

  it("provider identifiers are write-once so a resource is never orphaned", () => {
    const guard = body(GUARD);
    for (const col of ["phone_number_sid", "messaging_service_sid", "phone_number", "provisioned_at"]) {
      expect(guard).toMatch(
        new RegExp(`old\\.${col} is not null\\s*\\n\\s*and new\\.${col} is distinct from old\\.${col}`),
      );
    }
  });

  it("the claim survives a failure, so a purchase stays discoverable", () => {
    const fail = body(FAIL);
    expect(fail).toMatch(/set status\s*=\s*'error'/);
    // It must NOT clear the key.
    expect(fail).not.toMatch(/provisioning_claim_key\s*=\s*null/);
  });
});

describe("a live claim EXCLUDES a second request", () => {
  it("a fresh claim returns claim_held with NO key", () => {
    const claim = body(CLAIM);
    expect(claim).toMatch(
      /if v_row\.provisioning_claim_at > now\(\) - c_claim_lease then\s*\n\s*return query select 'claim_held'::text, v_row\.id, null::text/,
    );
  });

  it("a stale claim is taken over on the SAME key", () => {
    const claim = body(CLAIM);
    const takeover = claim.slice(claim.indexOf("c_claim_lease then"));
    expect(takeover).toMatch(/set provisioning_claim_at = now\(\)/);
    // The takeover updates only the lease; it does not touch the key.
    expect(takeover).not.toMatch(/set[\s\S]{0,120}provisioning_claim_key\s*=/);
  });

  it("the studio row is locked so claimants serialize", () => {
    expect(body(CLAIM)).toContain("for update");
  });
});

// ---------------------------------------------------------------------------
// 6. ACTIVE is a proof
// ---------------------------------------------------------------------------

describe("readiness — active is unreachable without proof", () => {
  it("the CHECK requires every identifier AND a successful test", () => {
    const check = CODE.slice(
      CODE.indexOf(`add constraint ${TABLE}_active_readiness_check`),
      CODE.indexOf(";", CODE.indexOf(`add constraint ${TABLE}_active_readiness_check`)),
    );
    expect(check).toContain("status <> 'active'");
    for (const limb of [
      "phone_number          is not null",
      "phone_number_sid  is not null",
      "messaging_service_sid is not null",
      "provisioned_at    is not null",
      "last_test_ok_at   is not null",
    ]) {
      expect(check).toContain(limb);
    }
  });

  it("finalize reaches active only when the test passed", () => {
    const finalize = body(FINALIZE);
    expect(finalize).toMatch(/when p_test_ok is true then 'active'/);
    expect(finalize).toMatch(/else 'provisioning'/);
    expect(finalize).toMatch(/case when p_test_ok is true then now\(\) else v_row\.last_test_ok_at end/);
  });

  it("finalize never silently overwrites a different provider resource", () => {
    expect(body(FINALIZE)).toContain("'conflict'");
  });

  it("finalize is addressed by studio AND claim key together", () => {
    expect(body(FINALIZE)).toMatch(
      /where s\.studio_id\s*=\s*p_studio_id\s*\n\s*and s\.provisioning_claim_key = p_claim_key/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Server-assigned evidence
// ---------------------------------------------------------------------------

describe("evidence is dated by the server", () => {
  it("insert timestamps are stamped by trigger, never accepted from a caller", () => {
    const stamps = body(STAMPS);
    expect(stamps).toContain("new.created_at := now();");
    expect(stamps).toContain("new.updated_at := now();");
    expect(CODE).toMatch(new RegExp(`create trigger ${STAMPS}\\s*\\n\\s*before insert on public\\.${TABLE}`));
  });

  it("created_at is immutable thereafter", () => {
    expect(body(GUARD)).toContain("new.created_at is distinct from old.created_at");
  });

  it("the persisted error tag cannot carry a number or a token", () => {
    expect(CODE).toMatch(/last_error_code ~ '\^\[a-z\]\[a-z0-9_\]\{2,63\}\$'/);
    // And the command coerces anything non-conforming rather than storing it.
    expect(body(FAIL)).toContain("'provider_error_unspecified'");
  });
});

// ---------------------------------------------------------------------------
// 8. Privileges — the 0129 / 0164 failure class
// ---------------------------------------------------------------------------

describe("privileges", () => {
  it("the table is revoked from every role by name before anything is granted", () => {
    expect(CODE).toMatch(
      new RegExp(`revoke all on public\\.${TABLE}\\s*\\n\\s*from public, anon, authenticated, service_role;`),
    );
  });

  it("the browser's grant is COLUMN-LEVEL and excludes every provider identifier", () => {
    const grant = CODE.slice(
      CODE.indexOf("grant select ("),
      CODE.indexOf(`) on public.${TABLE} to authenticated;`),
    );
    expect(grant).toBeTruthy();
    for (const secret of ["phone_number_sid", "messaging_service_sid", "provisioning_claim_key"]) {
      expect(grant).not.toContain(secret);
    }
    // Status the owner legitimately needs IS granted.
    for (const visible of ["status", "phone_number", "last_error_code"]) {
      expect(grant).toContain(visible);
    }
  });

  it.each(COMMANDS)("%s is revoked from all four roles by name", (fn) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ${role};`),
      );
    }
  });

  it.each(COMMANDS)("%s is granted to service_role only", (fn) => {
    const grants = [...CODE.matchAll(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (\\w+);`, "g"))];
    expect(grants.map((m) => m[1])).toEqual(["service_role"]);
  });

  it("the trigger functions are executable by nobody", () => {
    for (const fn of [STAMPS, GUARD]) {
      expect(CODE).toMatch(
        new RegExp(`revoke all privileges on function public\\.${fn}\\(\\)\\s*\\n\\s*from public, anon, authenticated, service_role;`),
      );
    }
  });

  it.each(COMMANDS)("%s is SECURITY DEFINER with a pinned search_path", (fn) => {
    const src = body(fn);
    expect(src).toContain("security definer");
    expect(src).toContain("set search_path = pg_catalog, pg_temp");
  });
});

// ---------------------------------------------------------------------------
// 9. Authorization is re-derived
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("claim re-derives membership and owner role from the actor's user id", () => {
    const claim = body(CLAIM);
    expect(claim).toMatch(/from public\.practitioners p\s*\n\s*where p\.studio_id = p_studio_id\s*\n\s*and p\.user_id\s*= p_actor_user_id\s*\n\s*and p\.active\s*= true/);
    expect(claim).toContain("if v_role <> 'owner' then");
    expect(claim).toContain("'not_owner'");
    expect(claim).toContain("'not_a_member'");
  });

  it("no command accepts a role, a practitioner id, or a membership claim", () => {
    for (const fn of COMMANDS) {
      const signature = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}`),
        CODE.indexOf("language", CODE.indexOf(`create or replace function public.${fn}`)),
      );
      expect(signature).not.toContain("p_role");
      expect(signature).not.toContain("p_practitioner_id");
      expect(signature).not.toContain("p_is_owner");
    }
  });

  it("the studio is verified to exist before any membership lookup", () => {
    const claim = body(CLAIM);
    expect(claim.indexOf("'studio_not_found'")).toBeLessThan(claim.indexOf("'not_a_member'"));
  });
});

// ---------------------------------------------------------------------------
// 10. Documentation
// ---------------------------------------------------------------------------

describe("the file explains itself", () => {
  it("comments the table, the claim key, and every command", () => {
    expect(CODE).toContain(`comment on table public.${TABLE} is`);
    expect(CODE).toContain(`comment on column public.${TABLE}.provisioning_claim_key is`);
    for (const fn of COMMANDS) {
      expect(CODE).toMatch(new RegExp(`comment on function public\\.${fn}\\(`));
    }
  });

  it("states that no credential is stored per studio", () => {
    expect(SQL).toMatch(/NO CREDENTIALS ARE STORED PER STUDIO/);
  });
});
