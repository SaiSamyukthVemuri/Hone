import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0193 — prospect preference vs studio admission policy (WAIT-ADMIT-01).
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half lives in tests/db/waitlist-admission-authority.db.test.ts and
// proves what it DOES. Neither is sufficient alone: a behavioural test cannot
// prove a grant line was WRITTEN rather than inherited from Supabase's
// create-time defaults, and SQL text cannot prove a member is actually refused.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * move admission policy onto `studios` -> the no-studios-column assertion
//     fails. That is the disproved model: ALTER DEFAULT PRIVILEGES gives anon
//     and authenticated table-level UPDATE across all of studios' columns, and
//     a column-level revoke cannot remove a table-level grant;
//   * grant a table-level SELECT on the grants table -> the token_hash
//     assertion fails, and an authenticated owner could read a live verifier
//     because RLS scopes rows, not columns;
//   * add an insert/update/delete POLICY to any new table -> the read-only
//     assertion fails, and a browser session would have a write path;
//   * forget one of the four grantees in a revoke -> the privilege assertions
//     fail, which is the 0129 / 0164 failure class;
//   * relax the unconditional joined_at stamp for the PUBLIC path -> the
//     trigger assertion fails, and an anonymous submitter could forge an
//     earlier queue position;
//   * drop `source` from the trigger's condition -> a legacy import's real
//     join date silently becomes today, which is the fabrication
//     joined_at_provenance exists to prevent.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0193";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's header
// names the very things it forbids, so every "does not contain" assertion runs
// against comment-stripped SQL rather than the raw file.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

const TABLES = [
  "public.new_client_waitlist_entry_preferences",
  "public.new_client_waitlist_preference_grants",
  "public.studio_waitlist_admission_policy",
] as const;

const COMMANDS: readonly [string, string][] = [
  ["public.create_practitioner_waitlist_entry", "uuid, uuid, text, text, text, text"],
  ["public.import_legacy_waitlist_entry", "uuid, uuid, text, text, timestamptz, text, text"],
  ["public.set_waitlist_entry_availability", "uuid, uuid, uuid, text"],
  ["public.issue_waitlist_preference_grant", "uuid, uuid, uuid, integer"],
  ["public.revoke_waitlist_preference_grant", "uuid, uuid, uuid"],
  ["public.redeem_waitlist_preference_grant", "text, text"],
  ["public.set_studio_waitlist_admission_policy", "uuid, uuid, jsonb, integer, integer"],
  ["public.claim_new_client_waitlist_entries_ordered", "uuid, uuid, uuid[]"],
];

describe("0193 position in the chain", () => {
  it("is the repository maximum", () => {
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
  });
});

describe("transaction and lock posture", () => {
  it("opens its own transaction and arms a lock timeout inside it", () => {
    // `supabase db push` does not wrap a file, so a bare SET LOCAL outside a
    // transaction emits 25P01 and never arms.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("keeps every identifier within PostgreSQL's 63-character limit", () => {
    // A longer name is silently TRUNCATED, so `drop constraint if exists` stops
    // matching and the migration is no longer idempotent.
    const overlong = Array.from(SQL.matchAll(/[a-z_]{40,}/g))
      .map((m) => m[0])
      .filter((id) => id.length > 63);
    expect(Array.from(new Set(overlong))).toEqual([]);
  });
});

describe("the disproved privilege model is not reintroduced", () => {
  it("adds NO column to public.studios", () => {
    expect(/alter\s+table\s+public\.studios/i.test(CODE)).toBe(false);
  });

  it("keeps admission policy in its own table", () => {
    expect(CODE).toContain("create table if not exists public.studio_waitlist_admission_policy");
  });

  it("does not create 0192's admission-rounds table, though it does use it", () => {
    // That object belongs to 0192. Creating it here would collide; LOCKING it
    // is required, because the admission command must take the canonical
    // studios -> rounds -> entry order before it claims anything.
    expect(CODE).not.toMatch(/create table[^;]*studio_waitlist_admission_rounds/i);
    expect(CODE).toContain("from public.studio_waitlist_admission_rounds r");
    expect(CODE).toContain("for update");
  });
});

describe("privileges are explicit, never inherited", () => {
  it.each(TABLES)("revokes all four grantees on %s", (table) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke all on ${table} from ${role};`);
    }
  });

  it.each(TABLES)("grants %s no write privilege to any role", (table) => {
    const writes = new RegExp(
      `grant\\s+(insert|update|delete|all)[^;]*on\\s+${table.replace(".", "\\.")}`,
      "i",
    );
    expect(writes.test(CODE)).toBe(false);
  });

  it("grants SELECT by COLUMN LIST, never whole-table, on every new table", () => {
    for (const table of TABLES) {
      expect(CODE).toMatch(new RegExp(`grant select \\([^)]+\\) on ${table.replace(".", "\\.")} to authenticated;`));
      expect(CODE).not.toContain(`grant select on ${table} to authenticated;`);
    }
  });

  it("never grants a table privilege to service_role", () => {
    // A SECURITY DEFINER command executes as its owner, so the server's most
    // privileged client can run the commands and cannot dump the tables.
    for (const table of TABLES) {
      expect(CODE).not.toMatch(new RegExp(`grant[^;]*on ${table.replace(".", "\\.")} to service_role`, "i"));
    }
  });

  it("never grants anything to anon", () => {
    expect(CODE).not.toMatch(/grant[^;]*to anon\b/i);
  });

  it("excludes token_hash from the readable column list", () => {
    const grant = CODE.match(
      /grant select \(([^)]+)\) on public\.new_client_waitlist_preference_grants to authenticated;/,
    );
    expect(grant).not.toBeNull();
    const columns = grant![1].split(",").map((c) => c.trim());
    expect(columns).not.toContain("token_hash");
    expect(columns).toContain("expires_at");
  });

  it.each(COMMANDS)("revokes EXECUTE on %s from all four grantees by name", (fn, args) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${fn}(${args}) from ${role};`);
    }
    expect(CODE).toContain(`grant execute on function ${fn}(${args}) to service_role;`);
  });

  it("writes the grant statements literally, never through format()", () => {
    // The grant guards read these textually; a DO-block would hide them.
    expect(CODE).not.toMatch(/execute\s+format\([^)]*grant/i);
  });
});

describe("RLS is read-only and owner-scoped", () => {
  it.each(TABLES)("enables row level security on %s", (table) => {
    expect(CODE).toContain(`alter table ${table} enable row level security;`);
  });

  it("declares only FOR SELECT policies, all TO authenticated", () => {
    const policies = Array.from(CODE.matchAll(/create policy[\s\S]*?;/g)).map((m) => m[0]);
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).toContain("for select to authenticated");
      expect(p).toContain("public.is_studio_owner(");
      // is_studio_member would be the broader, lazier predicate.
      expect(p).not.toContain("is_studio_member");
    }
  });

  it("declares no insert, update or delete policy anywhere", () => {
    expect(CODE).not.toMatch(/create policy[\s\S]{0,200}for\s+(insert|update|delete|all)\b/i);
  });
});

describe("structural tenancy", () => {
  it("binds every child row to its parent by COMPOSITE (id, studio_id)", () => {
    // A single-column FK would let a row reference a parent in another studio
    // even if a policy were wrong.
    for (const ref of [
      "references public.new_client_waitlist_entries (id, studio_id)",
      "references public.practitioners (id, studio_id)",
    ]) {
      expect(CODE).toContain(ref);
    }
  });

  it("carries studio_id on every new table", () => {
    expect(CODE).toMatch(/create table if not exists public\.new_client_waitlist_entry_preferences[\s\S]*?studio_id\s+uuid not null/);
    expect(CODE).toMatch(/create table if not exists public\.new_client_waitlist_preference_grants[\s\S]*?studio_id\s+uuid not null/);
  });
});

describe("provenance vocabulary and its coherence rules", () => {
  it("widens source to exactly the three accepted origins", () => {
    expect(CODE).toContain("check (source in ('public_booking', 'practitioner', 'legacy_import'))");
  });

  it("names the three join-date provenances", () => {
    expect(CODE).toContain("check (joined_at_provenance in ('form', 'operator_supplied', 'unknown'))");
  });

  it("lets only the public form claim 'form'", () => {
    expect(CODE).toContain("(source = 'public_booking' and joined_at_provenance = 'form')");
    expect(CODE).toContain("joined_at_provenance in ('operator_supplied', 'unknown')");
  });

  it("requires a named creator for operator-originated entries, both directions", () => {
    expect(CODE).toContain("(source = 'public_booking' and created_by_practitioner_id is null)");
    expect(CODE).toContain("(source <> 'public_booking' and created_by_practitioner_id is not null)");
  });

  it("does not relax the name constraint or add a name provenance", () => {
    expect(CODE).not.toContain("name_provenance");
    expect(CODE).not.toMatch(/drop constraint[^;]*name_check/i);
  });
});

describe("preference vocabulary and the two timestamps", () => {
  it("stores exactly the weekday/weekend/both vocabulary", () => {
    expect(CODE).toContain("check (preference in ('weekdays', 'weekends', 'both'))");
  });

  it("keeps stated_at and confirmed_at as separate NOT NULL columns", () => {
    expect(CODE).toMatch(/stated_at\s+timestamptz not null/);
    expect(CODE).toMatch(/confirmed_at\s+timestamptz not null/);
    expect(CODE).toContain("check (confirmed_at >= stated_at)");
  });

  it("names a practitioner only for a practitioner-recorded preference", () => {
    expect(CODE).toContain("(source = 'practitioner' and recorded_by_practitioner_id is not null)");
    expect(CODE).toContain("(source <> 'practitioner' and recorded_by_practitioner_id is null)");
  });
});

describe("the token is stored only as a hash", () => {
  it("declares no raw-token column", () => {
    expect(CODE).not.toMatch(/\braw_token\s+text\s+not null/);
    expect(CODE).toContain("token_hash                text not null");
  });

  it("pins the verifier shape and generates the token in the database", () => {
    expect(CODE).toContain("check (token_hash ~ '^[a-f0-9]{64}$')");
    expect(CODE).toContain("encode(extensions.gen_random_bytes(32), 'hex')");
  });

  it("permits at most one live grant per entry", () => {
    expect(CODE).toContain("where redeemed_at is null and revoked_at is null");
  });
});

describe("the server-timestamp trigger repair", () => {
  it("still forces joined_at for the public path", () => {
    expect(CODE).toContain("if new.source = 'public_booking' or new.joined_at is null then");
    expect(CODE).toContain("new.joined_at := now();");
  });

  it("stamps updated_at unconditionally", () => {
    expect(CODE).toMatch(/new\.updated_at := now\(\);\s*\n\s*return new;/);
  });

  it("revokes the replaced trigger function from all four grantees", () => {
    expect(CODE).toContain(
      "revoke all privileges on function public.new_client_waitlist_entries_server_timestamps()\n  from public, anon, authenticated, service_role;",
    );
  });
});

describe("the ordered claim keeps what the FIFO claim owns", () => {
  it("keeps contention and the single decision instant in the database", () => {
    expect(CODE).toContain("for update of e skip locked");
    expect(CODE).toContain("candidates as materialized");
    expect(CODE).toContain("decision as materialized");
    expect(CODE).toContain("select clock_timestamp() as decision_at from candidates limit 1");
  });

  it("preserves the caller's order rather than re-sorting", () => {
    expect(CODE).toContain("unnest(p_entry_ids) with ordinality");
    expect(CODE).toContain("order by r.ord");
  });

  it("lets a configured batch ceiling only tighten the existing bound", () => {
    expect(CODE).toContain("if v_n < 1 or v_n > 100 then");
    expect(CODE).toContain("if v_cap is not null and v_n > v_cap then");
  });
});

describe("every command re-derives owner authority in the database", () => {
  it.each(COMMANDS.filter(([fn]) => !fn.includes("redeem")))(
    "%s resolves the actor through new_client_waitlist_resolve_owner",
    (fn) => {
      const body = CODE.slice(CODE.indexOf(`create or replace function ${fn}(`));
      expect(body.slice(0, 4000)).toContain("new_client_waitlist_resolve_owner");
    },
  );

  it("the prospect path takes NO actor and NO studio from its caller", () => {
    // Authority is the token alone, so there is no id to forge.
    expect(CODE).toContain("public.redeem_waitlist_preference_grant(\n  p_raw_token  text,\n  p_preference text\n)");
  });

  it("declares every command SECURITY DEFINER with a pinned search_path", () => {
    const defs = Array.from(CODE.matchAll(/create or replace function public\.[a-z_]+\([\s\S]*?\$\$;/g));
    expect(defs.length).toBeGreaterThanOrEqual(COMMANDS.length);
    for (const d of defs) {
      expect(d[0]).toContain("security definer");
      expect(d[0]).toContain("set search_path = pg_catalog, pg_temp");
    }
  });
});

// ===========================================================================
// THE LOCK-DISCIPLINE AUDIT — mechanical, not a checklist
// ===========================================================================
//
// FIVE ROUNDS OF REVIEW FOUND FOUR SEPARATE LOCK DEFECTS IN THIS FILE, each one
// created by the repair before it, and each found by a human reading the SQL
// rather than by anything that could fail on its own. The last round is the
// reason this block exists: an exact-head review caught ONE command missing the
// studio lock, and a mechanical sweep of every command then found THREE MORE
// that were equally exposed and that nobody had flagged.
//
// So the rule is enforced here instead of remembered:
//
//   A 0193 command that writes a table carrying a `studios` foreign key MUST
//   take `studios ... for no key update` FIRST.
//
// WHY THE WRITE IMPLIES A STUDIO LOCK. Writing such a table takes an FK KEY
// SHARE lock on `studios` whether or not the command asks for one. Without an
// explicit lock the order is decided by whichever statement happens to run
// last, which is how the command ended up holding an entry and then reaching
// for the studio -- the exact inversion 0192's issuer deadlocks against.
//
// WHY `no key update` AND NOT `for update`. FOR UPDATE conflicts with KEY
// SHARE, so a studio-first FOR UPDATE moves the cycle rather than closing it:
// the 0185/0188 lifecycle writers hold an entry and then request KEY SHARE
// through their status-event trigger. NO KEY UPDATE is compatible with KEY
// SHARE and still excludes another NO KEY UPDATE, so cooperating writers
// serialise and FK checks pass. Measured, not assumed -- see the matrix
// assertion in tests/db/waitlist-admission-authority.db.test.ts.
//
// The transitive case is the one a reader misses: writing
// new_client_waitlist_entries fires 0185's record_event trigger, which inserts
// into new_client_waitlist_entry_events -- a table with its own studios FK.
describe("every command that reaches `studios` locks it first", () => {
  /** Tables with a direct `studios` FK, so writing one takes KEY SHARE on it. */
  const STUDIO_FK_TABLES = [
    "new_client_waitlist_entries",
    "new_client_waitlist_entry_events",
    "new_client_waitlist_invitations",
    "new_client_waitlist_preference_grants",
    "studio_waitlist_admission_policy",
    "studio_waitlist_admission_rounds",
  ] as const;

  // ---------------------------------------------------------------------
  // REACHABILITY, NOT LITERAL DML.
  //
  // The first version of this audit derived a command's writes from the
  // insert/update statements in its OWN body, and that exempted the one command
  // it most needed to cover. admit_new_client_waitlist_entry writes nothing
  // directly: it delegates to claim_new_client_waitlist_entry and to 0192's
  // issue_scoped_new_client_waitlist_invitation. Its write set came out EMPTY,
  // the rule did not apply, and removing its studio pre-lock left this audit
  // fully green while restoring the entry-before-studio deadlock. Measured, and
  // it is now the acceptance test at the bottom of this block.
  //
  // A command therefore reaches a table through three routes, and all three are
  // followed to a fixed point:
  //
  //   1. its own DML;
  //   2. any public.<fn>() it CALLS -- including commands defined in other
  //      migrations, which is why the whole migration set is parsed, not 0193;
  //   3. any TRIGGER on a table it writes -- the route that made this subtle in
  //      the first place, since writing new_client_waitlist_entries fires 0185's
  //      record_event trigger, which inserts into new_client_waitlist_entry_events.
  //
  // Function definitions are collected in migration order, last definition
  // winning, so a later `create or replace` is what the analysis sees -- exactly
  // as PostgreSQL would.
  // ---------------------------------------------------------------------

  type Analysis = {
    bodies: Map<string, string>;
    triggersOn: Map<string, string[]>;
  };

  function analyseMigrations(): Analysis {
    const dir = path.join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const bodies = new Map<string, string>();
    const triggersOn = new Map<string, string[]>();

    for (const file of files) {
      const raw = readFileSync(path.join(dir, file), "utf8");
      const text = raw
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n");

      const fnRe = /create\s+or\s+replace\s+function\s+(?:public\.)?(\w+)\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = fnRe.exec(text)) !== null) {
        const end = text.indexOf("$$;", m.index);
        if (end === -1) continue;
        bodies.set(m[1], text.slice(m.index, end)); // last definition wins
      }

      const trgRe =
        /create\s+trigger\s+\w+[\s\S]{0,120}?on\s+(?:public\.)?(\w+)[\s\S]{0,80}?execute\s+function\s+(?:public\.)?(\w+)/gi;
      while ((m = trgRe.exec(text)) !== null) {
        const list = triggersOn.get(m[1]) ?? [];
        if (!list.includes(m[2])) list.push(m[2]);
        triggersOn.set(m[1], list);
      }
    }
    return { bodies, triggersOn };
  }

  const ANALYSIS = analyseMigrations();

  /** Literal insert/update/delete targets in one body. */
  function literalWrites(body: string): string[] {
    const out = new Set<string>();
    const re = /(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(\w+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.add(m[1]);
    return [...out];
  }

  /** public.<fn>( invocations in one body, excluding the definition itself. */
  function calls(body: string): string[] {
    const out = new Set<string>();
    const re = /public\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.add(m[1]);
    return [...out];
  }

  /** Everything a command can write, through DML, calls and triggers alike. */
  function reachableWrites(name: string): Set<string> {
    const tables = new Set<string>();
    const seenFns = new Set<string>();
    const fnQueue = [name];

    while (fnQueue.length > 0 || true) {
      while (fnQueue.length > 0) {
        const fn = fnQueue.pop() as string;
        if (seenFns.has(fn)) continue;
        seenFns.add(fn);
        const body = ANALYSIS.bodies.get(fn);
        if (!body) continue;
        for (const t of literalWrites(body)) tables.add(t);
        for (const c of calls(body)) if (!seenFns.has(c)) fnQueue.push(c);
      }
      // Trigger hop: writing a table runs its triggers, which may write more.
      let grew = false;
      for (const t of [...tables]) {
        for (const trg of ANALYSIS.triggersOn.get(t) ?? []) {
          if (!seenFns.has(trg)) {
            fnQueue.push(trg);
            grew = true;
          }
        }
      }
      if (!grew && fnQueue.length === 0) break;
    }
    return tables;
  }

  type Command = { name: string; body: string; writes: string[]; locksStudio: boolean };

  function commands(): Command[] {
    const found: Command[] = [];
    const re = /create or replace function (public\.\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CODE)) !== null) {
      const body = CODE.slice(m.index, CODE.indexOf("$$;", m.index));
      // Trigger functions run inside their caller's transaction and take no
      // locks of their own; the CALLER is what this rule governs.
      if (/returns trigger/.test(body)) continue;
      const bare = m[1].replace(/^public\./, "");
      const reachable = reachableWrites(bare);
      found.push({
        name: m[1],
        body,
        writes: STUDIO_FK_TABLES.filter((t) => reachable.has(t)),
        locksStudio: /from public\.studios[^;]*for no key update/.test(body),
      });
    }
    return found;
  }

  it("resolves nested calls, so a delegating command is not exempt", () => {
    // The specific hole: admit_ writes nothing itself.
    const admit = commands().find((c) => c.name === "public.admit_new_client_waitlist_entry");
    expect(admit, "admit_ must be analysed").toBeDefined();
    expect(
      admit!.writes.length,
      "admit_ delegates its writes; the audit must follow the call",
    ).toBeGreaterThan(0);
    expect(admit!.writes).toContain("new_client_waitlist_entries");
  });

  it("follows the trigger hop from entries to the event table", () => {
    const claim = commands().find(
      (c) => c.name === "public.claim_new_client_waitlist_entries_ordered",
    );
    expect(claim).toBeDefined();
    // record_event fires on entries and inserts into entry_events.
    expect(claim!.writes).toContain("new_client_waitlist_entry_events");
  });

  it("finds the commands at all, so an empty sweep cannot pass vacuously", () => {
    const all = commands();
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(all.map((c) => c.name)).toContain("public.admit_new_client_waitlist_entry");
    expect(all.map((c) => c.name)).toContain(
      "public.claim_new_client_waitlist_entries_ordered",
    );
    // The analysis must have actually parsed other migrations, or the nested
    // resolution above is accidental.
    expect(ANALYSIS.bodies.has("claim_new_client_waitlist_entry")).toBe(true);
    expect(ANALYSIS.bodies.has("issue_scoped_new_client_waitlist_invitation")).toBe(true);
    expect(ANALYSIS.triggersOn.get("new_client_waitlist_entries") ?? []).toContain(
      "new_client_waitlist_entries_record_event",
    );
  });

  it("every command that can reach a studios-FK table takes the studio lock", () => {
    const offenders = commands()
      .filter((c) => c.writes.length > 0 && !c.locksStudio)
      .map((c) => `${c.name} reaches ${c.writes.join(", ")} without locking studios`);
    expect(offenders, "a new command must take `studios ... for no key update` first").toEqual([]);
  });

  it("no command uses the incompatible FOR UPDATE mode on studios", () => {
    // FOR UPDATE blocks the FK's KEY SHARE and reintroduces the deadlock.
    expect(CODE).not.toMatch(/from public\.studios[^;]*for update\b/i);
  });

  it("the studio lock precedes every entry lock, in every command that takes both", () => {
    for (const c of commands()) {
      const studio = c.body.search(/from public\.studios[^;]*for no key update/);
      const entry = c.body.search(/from public\.new_client_waitlist_entries[^;]*for update/);
      if (studio === -1 || entry === -1) continue;
      expect(studio, `${c.name} locks the entry before the studio`).toBeLessThan(entry);
    }
  });
});
