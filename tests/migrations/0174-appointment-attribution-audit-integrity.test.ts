import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax, versionsAbove, countVersion } from "./helpers/migration-state";

// ===========================================================================
// 0174 — APPOINTMENT BOUNDARY B5 source contract.
//
// Behaviour lives in tests/db/appointment-attribution-audit-integrity.db.test.ts
// (and in the B2/B3/B4 suites this migration must not regress). This file pins
// byte-level properties of the migration that behaviour cannot reach: what the
// file must contain, what it must NOT contain, and the ORDERING that makes it
// safe.
//
// Cloned from tests/migrations/0173-appointment-repair-commands.test.ts, which
// is the repository's template for a boundary migration test — including its
// hard-won lesson about anchored regexes (see EXECUTABLE below).
// ===========================================================================

const FILE = "supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

/**
 * The migration with `--` comment lines stripped. The header discusses every
 * forbidden pattern at length — `snapshot_appointment_buffer`, `revoke all`,
 * a generic audit trigger, the B8 grant it does NOT remove — so prose
 * describing a prohibition must never satisfy a guard looking for it.
 */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

/**
 * Executable statements, split on `;` at the TOP LEVEL only.
 *
 * A naive `CODE.split(";")` shreds every plpgsql body into fragments, because
 * `$function$ ... ; ... ; ... $function$` is full of semicolons. That is not a
 * cosmetic problem: it makes "exactly five backfills" count UPDATEs inside
 * function bodies, and it makes every whole-function assertion below match
 * against a truncated head. The dollar-quote tags are tracked so a body is one
 * statement.
 *
 * NOT `^create` anywhere below either — anchoring at column 0 makes a statement
 * indented by a single space INVISIBLE to every guard built on it. The 0172
 * adversarial pass demonstrated four mutants that survived a full suite exactly
 * that way. Leading whitespace is consumed everywhere.
 */
function splitTopLevel(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let tag: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    if (tag === null) {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        tag = m[0];
        buf += tag;
        i += tag.length - 1;
        continue;
      }
      if (sql[i] === ";") {
        out.push(buf.trim());
        buf = "";
        continue;
      }
    } else if (sql.startsWith(tag, i)) {
      buf += tag;
      i += tag.length - 1;
      tag = null;
      continue;
    }
    buf += sql[i];
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

const EXECUTABLE = splitTopLevel(CODE);

/** Index of the first executable statement matching `re`, or -1. */
const at = (re: RegExp): number => EXECUTABLE.findIndex((s) => re.test(s));

const POSTCARE_COLUMNS = [
  "postcare_email_claimed_at",
  "postcare_email_failed_at",
  "postcare_email_last_attempt_at",
  "postcare_email_last_error",
  "postcare_email_send_attempts",
  "postcare_email_sent_at",
] as const;

// ---------------------------------------------------------------------------

describe("0174 — migration state", () => {
  // The CENTRAL tripwire, moved here from
  // tests/migrations/0173-appointment-repair-commands.test.ts when B5 landed.
  // Only the current maximum migration's own test carries it (CLAUDE.md §2).
  it("is no longer the repository maximum — B6 spent 0175 above it", () => {
    // Per CLAUDE.md only the CURRENT max may assert isRepoMax; that role passed
    // to 0175 when B6 landed. 0174 keeps a narrower, still-true claim: exactly
    // one migration sits above it.
    expect(isRepoMax("0174")).toBe(false);
    // Asserted as "at least one above" rather than an exact list: this block's
    // subject is 0174's own history, and pinning the exact set means every
    // future migration re-breaks a test that has nothing to do with it. It has
    // already had to move three times.
    expect(versionsAbove("0174").length).toBeGreaterThanOrEqual(1);
    expect(versionsAbove("0174")).toContain("0175");
  });

  it("consumes exactly ONE number — B6 took 0175, B7/B8 still reserved", () => {
    // B5 must not spend more than its own number. 0175 is now B6's and is
    // expected to exist; 0176 and 0177 remain reserved for B7 and B8.
    expect(countVersion("0174")).toBe(1);
    expect(countVersion("0175")).toBe(1);
    // B7 spent 0176; 0177 remains reserved for B8.
    expect(countVersion("0176")).toBe(1);
    expect(countVersion("0177")).toBe(0);
    // 0178 is the PARKED Phase-2 practitioner identity work, developed on
    // another branch. B5 must not create it either.
    expect(countVersion("0178")).toBe(0);
  });
});

describe("0174 — production truth: APPLIED 2026-08-10", () => {
  const LEDGER = readFileSync(
    join(__dirname, "..", "..", "docs/production/migration-ledger.md"),
    "utf8",
  );

  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );

  it("the 0174 apply stays RECORDED even though 0175 superseded it as hosted max", () => {
    // This block has now asserted three different current-state values in turn:
    // hosted 0173 (B5 authoring), hosted 0174 with 0175 pending (B6 authoring),
    // and now hosted 0175. `hosted_migration_max` is a statement about
    // PRODUCTION, not about this repository — it moves when an apply happens,
    // never when a file lands. 0175 (B6) was applied 2026-08-10T11:56:35Z.
    // Asserted as a floor, so the NEXT apply does not re-break a test whose
    // subject is 0174's history rather than the current head.
    expect(Number(rec.hosted_migration_max)).toBeGreaterThanOrEqual(175);
    // Repo and hosted agree again: nothing is pending above the applied max.
    // This assertion has now tracked three states in turn: hosted 0174 with
    // 0175 pending, hosted 0175 with 0176 pending, and — after B7's
    // migration-first apply — repo and hosted agreeing again at 0176.
    //
    // So it stops pinning a particular divergence and states the invariant that
    // actually matters: whatever production has applied, nothing in the repo
    // sits above it unapplied at rest. An authoring branch legitimately breaks
    // that temporarily and says so in ITS OWN migration's test; this block is
    // about 0174's history and should not have to move for every successor.
    expect(isRepoMax(rec.hosted_migration_max)).toBe(true);
    expect(versionsAbove(rec.hosted_migration_max)).toEqual([]);
  });

  it("the record carries the sha256 of the exact 0174 bytes that were applied", async () => {
    // THE FREEZE. If this hash ever changes, an applied migration has been
    // edited and a recorded production apply fact has been falsified. A future
    // semantic change is 0175+, never a rewrite of these bytes.
    const { createHash } = await import("node:crypto");
    const bytes = readFileSync(join(__dirname, "..", "..", FILE));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("479dc58dd76d6030bc33bd83fb30b0a7f930ca58330067bb98a3f6c16a949bbc");
    expect(rec.hosted_note).toContain(sha);
  });

  it("earlier applies stay recorded — 0173, 0172 and 0171 checksums are not dropped", () => {
    // A new apply record supersedes its predecessor; it does not erase the
    // frozen history behind it.
    expect(rec.hosted_note).toContain(
      "04973b15c7b4b5675faa0d4260e29d7e6ccac9fd4a96cd83cbfbea2b90ab97cb",
    );
    expect(rec.hosted_note).toContain(
      "b89b0d47a70ea2d4a7574bcc4223081cfe1d527394b3ef8b6d4c82bb090f42f1",
    );
    expect(rec.hosted_note).toContain(
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
    );
  });

  it("records the apply facts that measurement, not assumption, established", () => {
    // These claims moved from the current-state note to the LEDGER when 0175
    // superseded 0174 as hosted max. They are asserted at their new home rather
    // than dropped: cardinality was measured either side of the apply, and the
    // PostgREST probe is recorded as NOT RUN rather than quietly claimed.
    // (The line breaks are real — the ledger wraps, so match across whitespace.)
    expect(LEDGER).toMatch(/appointments \*\*308 → 308\*\*/);
    expect(LEDGER).toMatch(/appointment_audit\s+\*\*260 → 260\*\*/);
    expect(LEDGER).toMatch(/`appointment_audit_actor_id_type_ck` is intentionally `NOT VALID`/);
    expect(LEDGER).toMatch(/PostgREST live-credential probe: NOT RUN/);
    // The frozen 0174 checksum stays in the CURRENT record regardless.
    expect(rec.hosted_note).toContain(
      "479dc58dd76d6030bc33bd83fb30b0a7f930ca58330067bb98a3f6c16a949bbc",
    );
  });
});

describe("0174 — transaction and locking conventions", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    // `supabase db push` does not wrap a migration file in a transaction, so a
    // bare SET LOCAL emits 25P01 and never arms (0159 lesson, 0169:70-76).
    expect(CODE).toMatch(/^\s*begin;/m);
    expect(CODE).toMatch(/^\s*commit;/m);
    expect(at(/^begin$/)).toBeGreaterThanOrEqual(0);
    expect(at(/^set local lock_timeout = '5s'$/)).toBe(at(/^begin$/) + 1);
  });

  it("sets no statement_timeout — no migration in this repository does", () => {
    expect(CODE).not.toMatch(/statement_timeout/);
  });

  it("every new function pins a hardened search_path", () => {
    const fns = EXECUTABLE.filter((s) => /create or replace function/i.test(s));
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn, `function must pin search_path:\n${fn.slice(0, 200)}`).toMatch(
        /set search_path (=|to)/i,
      );
    }
  });
});

describe("0174 — the standing prohibitions B5 inherits", () => {
  it("never touches snapshot_appointment_buffer or any appointments trigger function", () => {
    // Production carries out-of-band GUC behaviour in that function which
    // exists in NO migration here (0172:212-218, 0173:32-38). Emitting
    // `create or replace` for it from repo source would silently delete a live
    // production behaviour.
    expect(CODE).not.toMatch(/snapshot_appointment_buffer/);
    expect(PROSE).toMatch(/snapshot_appointment_buffer/); // discussed, never emitted
  });

  it("uses no `revoke all` on a TABLE — every verb is named (the 0169 doctrine)", () => {
    for (const stmt of EXECUTABLE) {
      if (/^revoke all/i.test(stmt)) {
        // `revoke all on function` is the correct, narrow form for a new
        // trigger function that no role should execute. Table-level `revoke
        // all` is what the doctrine forbids, because it silently takes SELECT.
        expect(stmt, `revoke all must target a FUNCTION, not a table:\n${stmt}`).toMatch(
          /^revoke all on function/i,
        );
      }
    }
  });

  it("grants NO table privilege to anon or authenticated — B3 is not reopened", () => {
    for (const stmt of EXECUTABLE) {
      if (/^grant\b/i.test(stmt) && /\bon table\b/i.test(stmt)) {
        expect(stmt, `no browser-role table grant:\n${stmt}`).not.toMatch(
          /\bto\b[^;]*\b(anon|authenticated)\b/i,
        );
      }
    }
  });

  it("adds NO policy for INSERT/UPDATE/DELETE on either table", () => {
    const policies = EXECUTABLE.filter((s) => /^create policy/i.test(s));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/appointment_audit_member_read/);
    expect(policies[0]).toMatch(/for select to authenticated/i);
  });

  it("does NOT add a generic appointments audit trigger — the REJECTED architecture", () => {
    // 0174's header rejects inferring a business action from an arbitrary row
    // change. Any trigger on `appointments` created here would be that design.
    const triggers = EXECUTABLE.filter((s) => /^create trigger/i.test(s));
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) {
      expect(t, `0174 may only add triggers to appointment_audit:\n${t}`).toMatch(
        /on public\.appointment_audit/i,
      );
    }
    // And neither trigger function may INSERT an audit event.
    const fns = EXECUTABLE.filter((s) => /create or replace function public\.(appointment_audit_derive_trusted_fields|guard_appointment_audit_append_only)/i.test(s));
    expect(fns).toHaveLength(2);
    for (const fn of fns) {
      expect(fn).not.toMatch(/insert\s+into\s+public\.appointment_audit/i);
    }
  });

  it("does not consume B6/B7/B8 scope", () => {
    expect(CODE).not.toMatch(/guard_appointment_status_transition/);
    expect(CODE).not.toMatch(/set_updated_at/);
    expect(CODE).not.toMatch(/drop function[^;]*reschedule_appointment\b/i);
    expect(CODE).not.toMatch(/drop function[^;]*practitioner_move_appointment\b/i);
    expect(CODE).not.toMatch(/drop function[^;]*create_internal_appointment\b/i);
  });
});

describe("0174 — attribution columns and their FKs", () => {
  const ATTRIBUTION = [
    "created_by_practitioner_id",
    "cancelled_by_practitioner_id",
    "outside_availability_authorized_by_practitioner_id",
  ] as const;

  it("adds the five appointment attribution columns", () => {
    for (const col of [
      ...ATTRIBUTION,
      "outside_availability_authorized_role",
      "outside_availability_authorized_at",
    ]) {
      expect(CODE).toMatch(new RegExp(`add column if not exists ${col}\\b`));
    }
  });

  it("adds the two audit durability columns", () => {
    expect(CODE).toMatch(/add column if not exists studio_id\s+uuid/);
    expect(CODE).toMatch(/add column if not exists actor_practitioner_id uuid/);
  });

  it("every practitioner attribution FK is COMPOSITE same-studio and ON DELETE RESTRICT", () => {
    // Composite (column, studio_id) -> practitioners(id, studio_id) is what
    // makes cross-studio identity corruption structurally impossible: an id
    // from another tenant cannot satisfy the constraint at all.
    //
    // RESTRICT, not SET NULL: attribution is history. A practitioner who
    // created or cancelled an appointment cannot be deleted out from under the
    // record.
    for (const col of [...ATTRIBUTION, "actor_practitioner_id"]) {
      const stmt = EXECUTABLE.find(
        (s) => /^alter table/i.test(s) && s.includes(`foreign key (${col}, studio_id)`),
      );
      expect(stmt, `${col} must have a composite same-studio FK`).toBeDefined();
      expect(stmt!).toMatch(/references public\.practitioners \(id, studio_id\)/);
      expect(stmt!, `${col} must be ON DELETE RESTRICT`).toMatch(/on delete restrict/);
      expect(stmt!, `${col} FK must be added NOT VALID first`).toMatch(/not valid/);
    }
  });

  it("each attribution FK is then VALIDATEd — the backfill is proved, not assumed", () => {
    for (const name of [
      "appointments_created_by_practitioner_same_studio_fk",
      "appointments_cancelled_by_practitioner_same_studio_fk",
      "appointments_outside_availability_authorizer_same_studio_fk",
      "appointment_audit_actor_practitioner_same_studio_fk",
      "appointment_audit_studio_fk",
    ]) {
      expect(CODE, `${name} must be validated`).toMatch(
        new RegExp(`validate constraint ${name}`),
      );
    }
  });

  it("the audit studio FK is RESTRICT — the append-only convention, not CASCADE", () => {
    // clinical_audit_events, clinical_record_amendments and
    // clinical_record_snapshots all use RESTRICT for their studio key. CASCADE
    // would be the one remaining path that can ERASE audit history.
    const stmt = EXECUTABLE.find((s) => s.includes("add constraint appointment_audit_studio_fk"));
    expect(stmt).toBeDefined();
    expect(stmt!).toMatch(/references public\.studios \(id\)/);
    expect(stmt!).toMatch(/on delete restrict/);
    expect(stmt!).not.toMatch(/on delete cascade/);
  });

  it("the historical actor_id correlation is left NOT VALID, deliberately and explicitly", () => {
    // Production may hold rows written by since-dropped commands
    // (finalize_card_required_public_booking, dropped 0091:174) and B5 ran no
    // production probe. Enforced for new rows; not asserted about history.
    expect(CODE).toMatch(
      /add constraint appointment_audit_actor_id_type_ck[\s\S]*?not valid/,
    );
    expect(CODE, "must NOT validate a constraint whose history was never measured").not.toMatch(
      /validate constraint appointment_audit_actor_id_type_ck/,
    );
  });
});

describe("0174 — backfill never invents an actor", () => {
  const BACKFILLS = EXECUTABLE.filter((s) => /^update public\./i.test(s));

  it("performs exactly the five deterministic backfills", () => {
    expect(BACKFILLS).toHaveLength(5);
  });

  it("no backfill derives an actor from appointments.practitioner_id", () => {
    // The ASSIGNED practitioner is not evidence of who created or cancelled.
    // This is the single most dangerous available shortcut and it is banned.
    for (const b of BACKFILLS) {
      expect(
        b,
        `backfill must not read the assigned practitioner:\n${b.slice(0, 300)}`,
      ).not.toMatch(/=\s*a\.practitioner_id|set \w+ = \w*\.?practitioner_id\b/);
    }
  });

  it("every actor backfill requires actor_type='practitioner' and same-studio resolution", () => {
    const actorBackfills = BACKFILLS.filter((b) => /actor_id/.test(b));
    expect(actorBackfills.length).toBeGreaterThanOrEqual(4);
    for (const b of actorBackfills) {
      expect(b).toMatch(/actor_type = 'practitioner'/);
      expect(b).toMatch(/pr\.studio_id = aa\.studio_id|pr\.studio_id = a\.studio_id/);
    }
  });

  it("the creator and canceller backfills refuse AMBIGUOUS evidence", () => {
    // Two distinct practitioner-'created' rows means the creator is unknown,
    // and unknown must stay NULL rather than be resolved by an arbitrary
    // ordering.
    const creator = BACKFILLS.find((b) => /created_by_practitioner_id = ev\.actor_id/.test(b));
    const canceller = BACKFILLS.find((b) => /cancelled_by_practitioner_id = ev\.actor_id/.test(b));
    for (const b of [creator, canceller]) {
      expect(b).toBeDefined();
      expect(b!, "must gate on a single unambiguous audit row").toMatch(/ev\.n = 1/);
    }
    // The canceller additionally requires the row to actually BE cancelled.
    expect(canceller!).toMatch(/a\.status = 'cancelled'/);
  });

  // F5. The runtime writes `outside_availability_authorized_at = v_now` on every
  // authorising move and clears it when the flag flips false, so the column means
  // "when the override standing today was authorised". The backfill must agree.
  //
  // This is the ONLY backfill where the question is reachable: 3.3/3.4 exclude
  // any appointment with more than one qualifying row (`count(*)`), while the
  // override block deliberately admits ONE actor with several events
  // (`count(distinct actor_id)`) so a repeat authorisation still resolves.
  it("F5 — the override backfill takes the LATEST qualifying event, never the earliest", () => {
    const ovr = BACKFILLS.find((b) =>
      /outside_availability_authorized_by_practitioner_id = ev\.actor_id/.test(b),
    );
    expect(ovr).toBeDefined();
    // max(), and specifically NOT min(): a min() here would record when the
    // override was FIRST authorised, contradicting the runtime semantic.
    expect(ovr!, "must select the latest qualifying event").toMatch(
      /max\(aa\.created_at\)/,
    );
    expect(ovr!, "min() would mean 'first authorised', not 'authorised'").not.toMatch(
      /min\(aa\.created_at\)/,
    );
    // Ambiguity is still NULL, and the actor is still the single distinct one —
    // n = 1 is what stops max() pairing one actor's id with another's timestamp.
    expect(ovr!).toMatch(/count\(distinct aa\.actor_id\)/);
    expect(ovr!).toMatch(/ev\.n = 1/);
    expect(ovr!).toMatch(/min\(aa\.actor_id::text\)::uuid/);
  });

  it("F5 — the creator/canceller backfills are NOT changed by it", () => {
    // They exclude repeats outright (`count(*)`) and write no timestamp, so the
    // latest-vs-earliest question cannot arise there. Pinned so a future sweep
    // does not "consistently" apply max() where it would change meaning.
    const others = BACKFILLS.filter((b) =>
      /(created_by_practitioner_id|cancelled_by_practitioner_id) = ev\.actor_id/.test(b),
    );
    expect(others.length).toBe(2);
    for (const b of others) {
      expect(b).toMatch(/count\(\*\)/);
      expect(b).not.toMatch(/max\(aa\.created_at\)/);
    }
  });

  it("the override backfill derives 'owner' from the command gate, and only for flagged rows", () => {
    const ovr = BACKFILLS.find((b) =>
      /outside_availability_authorized_by_practitioner_id = ev\.actor_id/.test(b),
    );
    expect(ovr).toBeDefined();
    expect(ovr!).toMatch(/details ->> 'outside_availability' = 'true'/);
    expect(ovr!).toMatch(/a\.booked_outside_availability = true/);
    expect(ovr!).toMatch(/ev\.n = 1/);
    // 'owner' is a RECOVERED FACT: both commands refuse a non-owner override,
    // so an override audit row proves the actor's role at that moment. Reading
    // the role TODAY would be the guess.
    expect(ovr!).toMatch(/outside_availability_authorized_role\s*=\s*'owner'/);
    expect(
      PROSE,
      "the derivation must be justified in the file, not left as a magic literal",
    ).toMatch(/refuse[\s\S]{0,400}owner/i);
  });
});

describe("0174 — ordering is load-bearing", () => {
  it("the FK re-point to SET NULL comes BEFORE the append-only trigger", () => {
    // Installed the other way round, the DELETE arm would be live while the FK
    // still cascaded and EVERY appointment delete in the tree would fail.
    const repoint = at(/add constraint appointment_audit_appointment_id_fkey/);
    const appendOnly = at(/create trigger appointment_audit_append_only/);
    expect(repoint).toBeGreaterThanOrEqual(0);
    expect(appendOnly).toBeGreaterThanOrEqual(0);
    expect(repoint).toBeLessThan(appendOnly);
  });

  it("the backfills come BEFORE the derive trigger and the append-only trigger", () => {
    // The derive trigger forces created_at to now(); had it been installed
    // first it would still not affect UPDATEs, but the append-only trigger
    // absolutely would — the audit backfills are UPDATEs on that table.
    const lastBackfill = EXECUTABLE.map((s, i) => (/^update public\./i.test(s) ? i : -1))
      .filter((i) => i >= 0)
      .pop()!;
    expect(lastBackfill).toBeLessThan(at(/create trigger appointment_audit_derive_trusted_fields_trg/));
    expect(lastBackfill).toBeLessThan(at(/create trigger appointment_audit_append_only/));
  });

  it("studio_id is backfilled BEFORE it is made NOT NULL", () => {
    const backfill = at(/^update public\.appointment_audit aa\s+set studio_id/i);
    const notNull = at(/alter column studio_id set not null/);
    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(notNull).toBeGreaterThan(backfill);
  });

  it("appointment_id is made nullable BEFORE the FK is re-pointed", () => {
    expect(at(/alter column appointment_id drop not null/)).toBeLessThan(
      at(/add constraint appointment_audit_appointment_id_fkey/),
    );
  });

  it("the RLS rewrite comes after studio_id is NOT NULL", () => {
    expect(at(/alter column studio_id set not null/)).toBeLessThan(
      at(/create policy\s+appointment_audit_member_read/i),
    );
  });
});

describe("0174 — the parent FK really moves off CASCADE", () => {
  it("drops the cascading FK and re-adds it as ON DELETE SET NULL", () => {
    expect(CODE).toMatch(/drop constraint if exists appointment_audit_appointment_id_fkey/);
    const add = EXECUTABLE.find((s) =>
      s.includes("add constraint appointment_audit_appointment_id_fkey"),
    );
    expect(add).toBeDefined();
    expect(add!).toMatch(/on delete set null/);
    expect(add!, "the whole point is that it is no longer CASCADE").not.toMatch(
      /on delete cascade/,
    );
  });
});

describe("0174 — trusted INSERT derivation", () => {
  const derive = EXECUTABLE.find((s) =>
    /create or replace function public\.appointment_audit_derive_trusted_fields/i.test(s),
  );

  it("exists and is wired as BEFORE INSERT", () => {
    expect(derive).toBeDefined();
    const trg = EXECUTABLE.find((s) =>
      /create trigger appointment_audit_derive_trusted_fields_trg/i.test(s),
    );
    expect(trg).toBeDefined();
    expect(trg!).toMatch(/before insert on public\.appointment_audit/i);
    expect(trg!).toMatch(/for each row/i);
  });

  it("OVERWRITES created_at with the database clock unconditionally", () => {
    // Not `coalesce(new.created_at, now())` — that would still let a caller
    // choose. An unconditional assignment is the only form that closes it.
    expect(derive!).toMatch(/new\.created_at\s*:=\s*now\(\)/);
    expect(derive!).not.toMatch(/coalesce\s*\(\s*new\.created_at/i);
  });

  it("DERIVES studio_id from the parent appointment rather than trusting the caller", () => {
    expect(derive!).toMatch(/select a\.studio_id into v_studio_id/);
    expect(derive!).toMatch(/new\.studio_id\s*:=\s*v_studio_id/);
  });

  it("derives actor_practitioner_id and NULLs it for non-practitioner actors", () => {
    expect(derive!).toMatch(/new\.actor_type = 'practitioner'/);
    expect(derive!).toMatch(/pr\.studio_id = new\.studio_id/);
    expect(derive!, "the else arm is what refuses to invent a practitioner").toMatch(
      /else\s+new\.actor_practitioner_id\s*:=\s*null/,
    );
  });
});

describe("0174 — append-only with ONE exact referential exception", () => {
  const guard = EXECUTABLE.find((s) =>
    /create or replace function public\.guard_appointment_audit_append_only/i.test(s),
  );

  it("is wired as BEFORE UPDATE OR DELETE", () => {
    const trg = EXECUTABLE.find((s) => /create trigger appointment_audit_append_only/i.test(s));
    expect(trg).toBeDefined();
    expect(trg!).toMatch(/before update or delete on public\.appointment_audit/i);
  });

  it("permits ONLY the FK detach: NOT NULL -> NULL, whole row otherwise identical, parent gone", () => {
    expect(guard).toBeDefined();
    expect(guard!).toMatch(/old\.appointment_id is not null/);
    expect(guard!).toMatch(/new\.appointment_id is null/);
    // Whole-row jsonb comparison, NOT a hand-written column list — a column
    // added after today would be silently mutable under a column list.
    expect(guard!).toMatch(/to_jsonb\(new\)\s*-\s*'appointment_id'/);
    expect(guard!).toMatch(/to_jsonb\(old\)\s*-\s*'appointment_id'/);
    // The parent must ALREADY be gone. Without this the rule would be a general
    // "detach any row" bypass that hides live audit rows from the detail view.
    expect(guard!).toMatch(/not exists\s*\([\s\S]*from public\.appointments a where a\.id = old\.appointment_id/);
  });

  it("the exception is defined by DATA SHAPE and never by the calling role", () => {
    // A `current_user = 'service_role'` style carve-out would be a general
    // audit-edit bypass wearing a narrow name.
    expect(guard!).not.toMatch(/current_user|session_user|current_setting/i);
  });

  it("the DELETE arm has no exception at all", () => {
    // The studio FK is RESTRICT, so no cascade needs to delete an audit row and
    // there is no second carve-out to reason about.
    expect(guard!).not.toMatch(/tg_op = 'DELETE'[\s\S]{0,200}return old/i);
    expect(guard!).toMatch(/raise exception/i);
  });
});

describe("0174 — service_role narrowing (Option E)", () => {
  const REVOKED = ["insert", "update", "delete", "truncate", "references", "trigger", "maintain"];

  for (const table of ["appointments", "appointment_audit"]) {
    it(`revokes every write and maintenance verb on ${table} from service_role`, () => {
      const stmt = EXECUTABLE.find(
        (s) => /^revoke /i.test(s) && s.includes(`on table public.${table}`) && s.includes("service_role"),
      );
      expect(stmt, `${table} must have a service_role revoke`).toBeDefined();
      for (const verb of REVOKED) {
        expect(stmt!, `${table} must revoke ${verb}`).toMatch(new RegExp(`\\b${verb}\\b`));
      }
      // SELECT must NOT be named — server reads depend on it.
      expect(stmt!, `${table} must not revoke SELECT`).not.toMatch(/\bselect\b/i);
    });
  }

  it("grants column-level UPDATE on EXACTLY the six postcare columns, and nothing else", () => {
    const grant = EXECUTABLE.find((s) => /^grant update \(/i.test(s));
    expect(grant, "the temporary B8 postcare grant must exist").toBeDefined();
    expect(grant!).toMatch(/on table public\.appointments to service_role/);

    const cols = grant!
      .slice(grant!.indexOf("(") + 1, grant!.indexOf(")"))
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .sort();
    expect(cols).toEqual([...POSTCARE_COLUMNS].sort());
  });

  it("no lifecycle column can hide inside that grant", () => {
    const grant = EXECUTABLE.find((s) => /^grant update \(/i.test(s))!;
    for (const forbidden of [
      "status",
      "starts_at",
      "ends_at",
      "practitioner_id",
      "client_id",
      "studio_id",
      "cancelled_at",
      "cancelled_by",
      "cancellation_reason",
      "created_by_practitioner_id",
      "cancelled_by_practitioner_id",
    ]) {
      expect(grant!, `${forbidden} must not be grantable`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }
  });

  it("the B8 removal contract is recorded IN THE FILE, so B8 knows exactly what to delete", () => {
    // A temporary grant with no written expiry becomes permanent.
    expect(PROSE).toMatch(/B8\s*\/\s*0177 OWNS THE REMOVAL/i);
    expect(PROSE).toMatch(/revoke update/i);
    expect(PROSE).toMatch(/7 to 0|7 -> 0|from 7 to 0/i);
  });

  it("revokes direct EXECUTE on write_appointment_audit from every ordinary role", () => {
    const stmt = EXECUTABLE.find((s) =>
      /^revoke execute on function public\.write_appointment_audit/i.test(s),
    );
    expect(stmt).toBeDefined();
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(stmt!, `must revoke from ${role}`).toMatch(new RegExp(`\\b${role}\\b`));
    }
  });

  it("does NOT revoke EXECUTE on the B4 commands themselves", () => {
    // Internalising the helper must not disarm the repair commands that call it.
    for (const fn of ["revert_appointment_outcome", "set_appointment_notes"]) {
      const bad = EXECUTABLE.find(
        (s) => /^revoke execute/i.test(s) && s.includes(fn) && /service_role/.test(s),
      );
      expect(bad, `${fn} must keep service_role EXECUTE`).toBeUndefined();
    }
  });

  it("keeps service_role EXECUTE on the three re-emitted commands", () => {
    for (const fn of [
      "create_internal_appointment_v2",
      "practitioner_cancel_appointment",
      "move_or_reassign_appointment",
    ]) {
      const stmt = EXECUTABLE.find(
        (s) => /^revoke execute on function/i.test(s) && s.includes(`public.${fn}(`),
      );
      expect(stmt, `${fn} should re-revoke the browser roles`).toBeDefined();
      expect(stmt!).toMatch(/from public, anon, authenticated/);
      expect(stmt!, `${fn} must NOT lose service_role EXECUTE`).not.toMatch(/service_role/);
    }
  });
});

describe("0174 — the re-emitted commands keep their existing contracts", () => {
  const emitted = (name: string) =>
    EXECUTABLE.find((s) =>
      new RegExp(`create or replace function public\\.${name}\\(`, "i").test(s),
    );

  it("re-emits exactly three commands", () => {
    const fns = EXECUTABLE.filter((s) =>
      /^create or replace function public\.(create_internal_appointment_v2|practitioner_cancel_appointment|move_or_reassign_appointment)\(/i.test(
        s,
      ),
    );
    expect(fns).toHaveLength(3);
  });

  it("create_internal_appointment_v2 keeps every sentinel and gate it had", () => {
    const fn = emitted("create_internal_appointment_v2")!;
    for (const sentinel of [
      "studio_not_found",
      "booking_paused",
      "not_authorized",
      "invalid_practitioner",
      "invalid_client",
      "invalid_service",
      "not_eligible",
      "invalid_duration",
      "invalid_time",
    ]) {
      expect(fn, `sentinel ${sentinel} must survive the re-emission`).toContain(sentinel);
    }
    // The lock order and the owner gates.
    expect(fn).toMatch(/from public\.studios s[\s\S]*?for update/);
    expect(fn).toMatch(/acquire_studio_capacity_lock/);
    expect(fn).toMatch(/practitioner_capacity_booking_enabled/);
    // The duration bounds, which a hand-retyped body would be very likely to
    // get wrong.
    expect(fn).toMatch(/< 15 or p_duration_override_minutes > 360/);
    expect(fn).toMatch(/% 15\)? <> 0/);
    // The attribution the migration exists to add.
    expect(fn).toMatch(/created_by_practitioner_id/);
    expect(fn).toMatch(/case when p_allow_outside_availability then p_actor_practitioner_id end/);
  });

  it("practitioner_cancel_appointment keeps the role word AND gains the practitioner id", () => {
    const fn = emitted("practitioner_cancel_appointment")!;
    expect(fn, "the role word is RETAINED, not replaced").toMatch(/cancelled_by\s*=\s*v_role/);
    expect(fn).toMatch(/cancelled_by_practitioner_id = p_practitioner_id/);
    for (const sentinel of ["not_authorized", "not_cancelable", "already_cancelled", "cancelled"]) {
      expect(fn).toContain(sentinel);
    }
    expect(fn, "the terminal-safe guard must survive").toMatch(/v_appt\.starts_at <= now\(\)/);
  });

  it("move_or_reassign_appointment CLEARS override attribution when the flag goes false", () => {
    const fn = emitted("move_or_reassign_appointment")!;
    // `case when <flag> then <actor> end` with no ELSE yields NULL — that is
    // the clearing arm. PR #520 A-P2-01: "a later move preserves it silently".
    expect(fn).toMatch(
      /outside_availability_authorized_by_practitioner_id\s*=\s*case when p_allow_outside_availability then p_actor_practitioner_id end/,
    );
    expect(fn).toMatch(
      /outside_availability_authorized_role\s*=\s*case when p_allow_outside_availability then v_actor_role end/,
    );
    // Optimistic concurrency must survive, in the exact operand order the
    // installed function uses.
    expect(fn).toMatch(/v_appt\.starts_at is distinct from p_expected_starts_at/);
    expect(fn).toMatch(/v_appt\.ends_at is distinct from p_expected_ends_at/);
  });

  it("the public/client commands are NOT re-emitted — their actor is genuinely the client", () => {
    for (const fn of [
      "create_public_appointment",
      "reschedule_appointment_v2",
      "public_cancel_appointment_with_token",
    ]) {
      expect(
        CODE,
        `${fn} must not be touched — writing a practitioner there would manufacture one`,
      ).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`, "i"));
    }
  });
});
