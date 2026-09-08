import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { adminQuery, closePool } from "./helpers/harness";

// ===========================================================================
// 0193 LOCK DISCIPLINE — DERIVED FROM THE SCHEMA, NOT FROM SQL TEXT
// ===========================================================================
//
// THE RULE
//
//   A 0193 command that can reach a table carrying a `studios` foreign key MUST
//   take `studios ... for no key update` FIRST -- before any write, any row
//   lock, and any call to a command that writes.
//
// WHY THE WRITE IMPLIES A STUDIO LOCK. Writing such a table takes an FK KEY
// SHARE lock on `studios` whether or not the command asks for one. Without an
// explicit lock the order is decided by whichever statement runs last, which is
// how a command ends up holding an entry and then reaching for the studio --
// the inversion 0192's issuer deadlocks against.
//
// WHY `no key update` AND NOT `for update`. FOR UPDATE conflicts with KEY
// SHARE, so a studio-first FOR UPDATE moves the cycle rather than closing it:
// the 0185/0188 lifecycle writers hold an entry and then request KEY SHARE
// through their status-event trigger.
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES HERE AND NOT IN THE SOURCE CONTRACT
// ---------------------------------------------------------------------------
//
// It began as a text-parsing guard in tests/migrations/. Review found FIVE
// holes in it across two rounds, and every one was the same shape: some valid
// PostgreSQL spelling the matcher did not recognise.
//
//   * a delegating command (admit_) whose writes are all in its callees, so its
//     literal-DML write set was empty and the rule did not apply -- MEASURED:
//     removing its studio lock left the audit green;
//   * a hard-coded list of studios-FK tables, so a NEW such table would be
//     silently discarded -- the exact omission class the guard exists to catch,
//     reproduced inside the guard;
//   * `MERGE INTO`, a valid write form the matcher did not know;
//   * overloads collapsed by bare name, so a writing 1-arg function could be
//     masked by a non-writing 2-arg one;
//   * an ordering assertion that only recognised a direct `SELECT ... FOR
//     UPDATE`, and SKIPPED any command that wrote before locking instead.
//
// A text matcher will always have another spelling it does not know. So the
// facts now come from the database, which cannot be fooled by syntax because it
// reports what PostgreSQL actually did:
//
//   pg_constraint  -> which tables really carry a studios FK
//   pg_proc        -> real bodies, and real signatures, so overloads stay apart
//   pg_trigger     -> which functions really fire on which tables
//
// Only ONE thing is still read from the migration file: the NAMES of the
// commands 0193 defines. That is identity, not analysis -- it is how the guard
// knows which commands are its own, and it means a command added to 0193 is
// picked up with no edit here.
//
// The cost, stated plainly: this needs a migrated database, so it runs in the
// db lane rather than everywhere. That is the trade for a guard that cannot be
// walked around by rewriting a statement.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/0193_waitlist_admission_authority.sql",
);

/** Command NAMES defined by 0193. Identity only; every fact comes from the DB. */
function commandNames(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const names = new Set<string>();
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return [...names];
}

type Fn = { name: string; args: string; src: string };

/**
 * Strip comments and string literals before matching.
 *
 * `prosrc` is the body PostgreSQL stored, comments and all -- and the comments
 * in these commands EXPLAIN the lock discipline, so they are full of the words
 * "for update" and "update". Matching raw prosrc flagged four commands at
 * positions that turned out to be inside the very paragraphs describing why the
 * lock is taken. String literals are stripped for the same reason: a refusal
 * code or an error message must not be able to read as DML.
 *
 * Replacement preserves LENGTH, so every position reported by a match still
 * points at the right offset in the original body.
 */
function normalise(src: string): string {
  return src
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length));
}

let FK_FRONTIER: Set<string>;
let FUNCTIONS: Map<string, Fn[]>; // name -> every overload
let TRIGGERS: Map<string, string[]>; // table -> trigger function names

async function loadSchema(): Promise<void> {
  const fk = await adminQuery(
    `select c.relname as tbl
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_class f on f.oid = con.confrelid
       join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and f.relname = 'studios' and n.nspname = 'public'`,
  );
  FK_FRONTIER = new Set(fk.rows.map((r: { tbl: string }) => r.tbl));

  const fns = await adminQuery(
    `select p.proname as name,
            pg_get_function_identity_arguments(p.oid) as args,
            coalesce(p.prosrc,'') as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`,
  );
  FUNCTIONS = new Map();
  for (const r of fns.rows as Fn[]) {
    const list = FUNCTIONS.get(r.name) ?? [];
    list.push(r);
    FUNCTIONS.set(r.name, list);
  }

  const trg = await adminQuery(
    `select c.relname as tbl, tp.proname as fn
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_proc tp on tp.oid = t.tgfoid
       join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public'`,
  );
  TRIGGERS = new Map();
  for (const r of trg.rows as { tbl: string; fn: string }[]) {
    const list = TRIGGERS.get(r.tbl) ?? [];
    if (!list.includes(r.fn)) list.push(r.fn);
    TRIGGERS.set(r.tbl, list);
  }
}

/**
 * Every static write form PostgreSQL accepts, MERGE included. A command must
 * not be able to shed the rule by rewriting an INSERT as a MERGE.
 */
const WRITE_RE =
  /(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(?:only\s+)?(?:public\.)?"?(\w+)"?/gi;

function literalWrites(src: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WRITE_RE.source, WRITE_RE.flags);
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out];
}

/** Calls, qualified or not. Membership in pg_proc is what makes a name a call. */
function callsFrom(src: string): string[] {
  const out = new Set<string>();
  const re = /(?:public\.)?(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (FUNCTIONS.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * Everything a command can write: own DML, callees (ALL overloads of a called
 * name, conservatively -- collapsing them is how a writing overload got masked),
 * and triggers on any table written. Iterated to a fixed point, alternating
 * call-expansion and trigger-expansion until neither adds anything.
 */
function reachableWrites(name: string): Set<string> {
  const tables = new Set<string>();
  const seen = new Set<string>();
  const queue = [name];

  for (;;) {
    while (queue.length > 0) {
      const fn = queue.pop() as string;
      if (seen.has(fn)) continue;
      seen.add(fn);
      for (const overload of FUNCTIONS.get(fn) ?? []) {
        const body = normalise(overload.src);
        for (const t of literalWrites(body)) tables.add(t);
        for (const c of callsFrom(body)) if (!seen.has(c)) queue.push(c);
      }
    }
    let grew = false;
    for (const t of [...tables]) {
      for (const trg of TRIGGERS.get(t) ?? []) {
        if (!seen.has(trg)) {
          queue.push(trg);
          grew = true;
        }
      }
    }
    if (!grew && queue.length === 0) return tables;
  }
}

const STUDIO_LOCK_RE = /from\s+public\.studios[^;]*for\s+no\s+key\s+update/i;
const STUDIO_FOR_UPDATE_RE = /from\s+public\.studios[^;]*for\s+update\b/i;

/**
 * The first position at which a command does something that must not precede
 * the studio lock: any write, any row lock, or any call into a command that
 * itself reaches the frontier.
 *
 * The earlier text guard compared the lock against a DIRECT `select ... for
 * update` only, so a command that wrote BEFORE locking produced -1 and was
 * skipped entirely rather than failed.
 */
function firstRelevantPosition(src: string): number {
  const candidates: number[] = [];
  const push = (re: RegExp) => {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(src)) !== null) candidates.push(m.index);
  };
  push(WRITE_RE);
  push(/for\s+update\b/gi);
  push(/for\s+no\s+key\s+update\b/gi);
  for (const callee of callsFrom(src)) {
    if ([...reachableWrites(callee)].some((t) => FK_FRONTIER.has(t))) {
      const at = src.search(new RegExp(`(?:public\\.)?${callee}\\s*\\(`));
      if (at !== -1) candidates.push(at);
    }
  }
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}

describe("0193 lock discipline, derived from the live schema", () => {
  it("loads the schema facts, so nothing below can pass vacuously", async () => {
    await loadSchema();
    // The frontier is DERIVED. A new studios-FK table joins it with no edit
    // here -- the hard-coded list was itself a finding.
    expect(FK_FRONTIER.size).toBeGreaterThan(10);
    expect(FK_FRONTIER.has("new_client_waitlist_entries")).toBe(true);
    expect(FK_FRONTIER.has("new_client_waitlist_entry_events")).toBe(true);
    expect(FK_FRONTIER.has("studio_waitlist_admission_policy")).toBe(true);
    // Callees really do live in other migrations.
    expect(FUNCTIONS.has("claim_new_client_waitlist_entry")).toBe(true);
    expect(FUNCTIONS.has("issue_scoped_new_client_waitlist_invitation")).toBe(true);
    // And the trigger hop is real, not assumed.
    expect(TRIGGERS.get("new_client_waitlist_entries") ?? []).toContain(
      "new_client_waitlist_entries_record_event",
    );
    expect(commandNames().length).toBeGreaterThanOrEqual(9);
  });

  it("resolves a delegating command through its callees", async () => {
    await loadSchema();
    // admit_ writes nothing itself. Under the old text guard its write set was
    // empty and it was exempt; removing its lock stayed green.
    const reach = reachableWrites("admit_new_client_waitlist_entry");
    expect(reach.has("new_client_waitlist_entries")).toBe(true);
    expect([...reach].some((t) => FK_FRONTIER.has(t))).toBe(true);
  });

  it("resolves the trigger hop from entries to the event table", async () => {
    await loadSchema();
    expect(
      reachableWrites("claim_new_client_waitlist_entries_ordered").has(
        "new_client_waitlist_entry_events",
      ),
    ).toBe(true);
  });

  it("every 0193 command reaching the frontier takes the studio lock", async () => {
    await loadSchema();
    const offenders: string[] = [];
    for (const name of commandNames()) {
      for (const fn of FUNCTIONS.get(name) ?? []) {
        const body = normalise(fn.src);
        const reach = [...reachableWrites(name)].filter((t) => FK_FRONTIER.has(t));
        if (reach.length === 0) continue;
        if (!STUDIO_LOCK_RE.test(body)) {
          offenders.push(`${name}(${fn.args}) reaches ${reach.sort().join(", ")} without locking studios`);
        }
      }
    }
    expect(offenders, "take `studios ... for no key update` first").toEqual([]);
  });

  it("no 0193 command uses the incompatible FOR UPDATE mode on studios", async () => {
    await loadSchema();
    const bad = commandNames().filter((n) =>
      (FUNCTIONS.get(n) ?? []).some((f) => STUDIO_FOR_UPDATE_RE.test(normalise(f.src))),
    );
    expect(bad, "FOR UPDATE blocks the FK's KEY SHARE and reopens the deadlock").toEqual([]);
  });

  it("the studio lock precedes the FIRST write, row lock or writing call", async () => {
    await loadSchema();
    const offenders: string[] = [];
    for (const name of commandNames()) {
      for (const fn of FUNCTIONS.get(name) ?? []) {
        const body = normalise(fn.src);
        const lock = body.search(STUDIO_LOCK_RE);
        if (lock === -1) continue; // covered by the rule above
        const first = firstRelevantPosition(body);
        if (first !== -1 && first < lock) {
          offenders.push(`${name}(${fn.args}) acts at ${first} before locking studios at ${lock}`);
        }
      }
    }
    expect(offenders, "the studio lock must come first, not merely exist").toEqual([]);
  });
});
