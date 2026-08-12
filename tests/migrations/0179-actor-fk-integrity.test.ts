import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0179 — actor FK integrity. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/actor-fk-integrity.db.test.ts. This file pins what a behavioural
// test cannot see: which relationships 0179 is ALLOWED to touch, which it must
// never touch, and that it mutates no business row.
//
// ---------------------------------------------------------------------------
// WHEN A SUCCESSOR IS AUTHORED (0180+), THIS BLOCK GOES RED ON PURPOSE.
// The fix is NOT to delete the assertions. Per CLAUDE.md §2 only the CURRENT
// repository maximum carries the current-state tripwire, so:
//   * convert "is the current repository maximum" to "is no longer the
//     repository maximum" plus versionsAbove(...).toContain("0180");
//   * keep countVersion("0179") === 1 — that claim is permanent;
//   * let 0180's own test become the single current-state tripwire.
// Do NOT weaken this block and leave two owners of current state.
// ---------------------------------------------------------------------------

const FILE = "supabase/migrations/0179_actor_fk_integrity.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header deliberately NAMES
// every relationship it does not touch, so a scope assertion over raw text
// would match the very prose documenting the discipline.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0179 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0179")).toBe(true);
    expect(versionsAbove("0179")).toEqual([]);
    expect(countVersion("0179")).toBe(1);
  });

  it("leaves 0180 free", () => {
    expect(countVersion("0180")).toBe(0);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });
});

describe("0179 — production truth: PENDING", () => {
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );

  it("is authored but NOT yet applied — hosted stays at 0178", () => {
    // 0179 is a pending migration. Recording its apply is a SEPARATE change
    // that also converts this block and hands 0178's floor forward.
    expect(rec.hosted_migration_max).toBe("0178");
    expect(Number.parseInt(rec.hosted_migration_max, 10)).toBeLessThan(179);
  });
});

describe("0179 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = lines.findIndex((l) => l === "begin;");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(lines[b + 1]).toBe("set local lock_timeout = '5s';");
    expect(lines[lines.length - 1]).toBe("commit;");
  });
});

// ---------------------------------------------------------------------------
// THE SEMANTIC BOUNDARY — the load-bearing claim of this migration.
// ---------------------------------------------------------------------------

describe("0179 — ACTOR relationships are made same-studio", () => {
  // Every column 0179 upgrades to a composite (col, studio_id) FK.
  const COMPOSITE = [
    ["audit_logs", "actor_id"],
    ["record_keeping_audit_events", "actor_practitioner_id"],
    ["imported_treatment_memory_audit_events", "actor_practitioner_id"],
    ["client_portal_access_events", "practitioner_id"],
    ["clients", "created_by"],
    ["clients", "archived_by"],
    ["client_tags", "created_by"],
    ["client_tags", "deleted_by"],
    ["client_pinned_notes", "created_by_practitioner_id"],
    ["client_intake_forms", "requested_by"],
    ["client_intake_forms", "reviewed_by"],
    ["consent_form_templates", "created_by_practitioner_id"],
    ["sessions", "deleted_by"],
    ["sessions", "finalized_by"],
    ["session_blocks", "deleted_by"],
    ["treatment_images", "uploaded_by"],
    ["treatment_images", "deleted_by"],
    ["treatment_plans", "created_by_practitioner_id"],
    ["treatment_plans", "closed_by_practitioner_id"],
    ["treatment_goals", "created_by"],
    ["record_keeping_sterile_items", "created_by_practitioner_id"],
    ["record_keeping_disinfectants", "created_by_practitioner_id"],
    ["record_keeping_exposure_incidents", "created_by_practitioner_id"],
    ["stripe_charge_attempts", "initiated_by_practitioner_id"],
    ["stripe_refund_attempts", "initiated_by_practitioner_id"],
    ["stripe_payment_audit", "practitioner_id"],
    ["ops_alerts", "resolved_by_practitioner_id"],
    ["clinical_audit_events", "actor_practitioner_id"],
    ["clinical_record_amendments", "authored_by"],
    ["clinical_record_snapshots", "finalized_by"],
    ["clinical_record_snapshots", "corrected_by"],
    ["client_portal_messages", "created_by_practitioner_id"],
    ["manual_fee_charge_attempts", "cancelled_by_practitioner_id"],
    ["payment_charge_attempts", "cancelled_by_practitioner_id"],
    ["pending_invitations", "invited_by"],
    ["studio_timed_blocks", "created_by"],
    ["studio_recurring_break_rules", "created_by"],
    ["client_personal_notes", "updated_by_practitioner_id"],
    ["client_clinical_notes", "practitioner_id"],
  ];

  it.each(COMPOSITE)(
    "%s.%s references practitioners (id, studio_id), never practitioners (id) alone",
    (table, column) => {
      const stmt = EXEC.match(
        new RegExp(
          `alter table public\\.${table}\\s+add constraint [a-z0-9_]+\\s+foreign key \\(${column}, studio_id\\)[\\s\\S]*?not valid;`,
        ),
      )?.[0];
      expect(stmt, `${table}.${column} has no composite FK statement`).toBeTruthy();
      expect(stmt).toMatch(/references public\.practitioners \(id, studio_id\)/);
    },
  );

  it("upgrades exactly 39 relationships — no silent widening", () => {
    const added = EXEC.match(/add constraint [a-z0-9_]+\s+foreign key \(/g) ?? [];
    expect(added.length).toBe(COMPOSITE.length);
    expect(added.length).toBe(39);
  });

  it("every added FK targets practitioners (id, studio_id) and nothing else", () => {
    const refs = EXEC.match(/references public\.[a-z_]+ \([a-z_, ]+\)/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r).toBe("references public.practitioners (id, studio_id)");
  });
});

describe("0179 — DURABLE actor attribution is delete-safe", () => {
  // 0174's distinction: durable actor/creator attribution RESTRICTs; only
  // current operational assignment may SET NULL.
  const RESTRICT = [
    "audit_logs_actor_same_studio_fk",
    "rk_audit_events_actor_same_studio_fk",
    "itm_audit_events_actor_same_studio_fk",
    "client_portal_access_events_practitioner_same_studio_fk",
    "clients_created_by_same_studio_fk",
    "clients_archived_by_same_studio_fk",
    "client_tags_created_by_same_studio_fk",
    "client_tags_deleted_by_same_studio_fk",
    "client_pinned_notes_created_by_same_studio_fk",
    "client_intake_forms_requested_by_same_studio_fk",
    "client_intake_forms_reviewed_by_same_studio_fk",
    "consent_form_templates_created_by_same_studio_fk",
    "sessions_deleted_by_same_studio_fk",
    "sessions_finalized_by_same_studio_fk",
    "session_blocks_deleted_by_same_studio_fk",
    "treatment_images_uploaded_by_same_studio_fk",
    "treatment_images_deleted_by_same_studio_fk",
    "treatment_plans_created_by_same_studio_fk",
    "treatment_plans_closed_by_same_studio_fk",
    "treatment_goals_created_by_same_studio_fk",
    "rk_sterile_items_created_by_same_studio_fk",
    "rk_disinfectants_created_by_same_studio_fk",
    "rk_exposure_incidents_created_by_same_studio_fk",
    "stripe_charge_attempts_initiated_by_same_studio_fk",
    "stripe_refund_attempts_initiated_by_same_studio_fk",
    "stripe_payment_audit_practitioner_same_studio_fk",
    "ops_alerts_resolved_by_same_studio_fk",
    "clinical_audit_events_actor_practitioner_id_same_studio_fk",
    "clinical_record_amendments_authored_by_same_studio_fk",
    "clinical_record_snapshots_finalized_by_same_studio_fk",
    "clinical_record_snapshots_corrected_by_same_studio_fk",
    "client_portal_messages_created_by_same_studio_fk",
    "manual_fee_charge_attempts_cancelled_by_same_studio_fk",
    "payment_charge_attempts_cancelled_by_same_studio_fk",
    // Added under its 0179 candidate name because the old CASCADE constraint
    // still occupies the canonical name until section 6 renames it back.
    "client_clinical_notes_practitioner_same_studio_0179",
  ];

  it.each(RESTRICT)("%s is ON DELETE RESTRICT", (name) => {
    const stmt = EXEC.match(
      new RegExp(`add constraint ${name}\\s+foreign key[\\s\\S]*?not valid;`),
    )?.[0];
    expect(stmt, `${name} not found`).toBeTruthy();
    expect(stmt).toMatch(/on delete restrict/);
    expect(stmt).not.toMatch(/on delete (set null|cascade)/);
  });

  // The four deliberate exceptions. Each sits on current operational state, not
  // durable evidence. If one of these ever moves, it must be a decision, not a
  // drift — so the list is pinned exactly.
  const KEEP_SET_NULL = [
    "pending_invitations_invited_by_same_studio_fk",
    "studio_timed_blocks_created_by_same_studio_fk",
    "studio_recurring_break_rules_created_by_same_studio_fk",
    "client_personal_notes_updated_by_same_studio_fk",
  ];

  it.each(KEEP_SET_NULL)("%s deliberately KEEPS ON DELETE SET NULL", (name) => {
    const stmt = EXEC.match(
      new RegExp(`add constraint ${name}\\s+foreign key[\\s\\S]*?not valid;`),
    )?.[0];
    expect(stmt, `${name} not found`).toBeTruthy();
    expect(stmt).toMatch(/on delete set null/);
  });

  it("emits no ON DELETE CASCADE anywhere — 0179 never widens destruction", () => {
    expect(EXEC).not.toMatch(/on delete cascade/);
  });

  it("accounts for every added constraint as either RESTRICT or deliberate SET NULL", () => {
    expect(RESTRICT.length + KEEP_SET_NULL.length).toBe(39);
  });
});

describe("0179 — OUT OF SCOPE relationships are not touched", () => {
  // Non-actor practitioner relationships. 0179 is actor-only: an assignment, a
  // resource, a recipient, a domain subject, a clinical performer and an
  // auth-user provenance column must each survive byte-for-byte.
  const UNTOUCHED = [
    // ASSIGNEE / RESOURCE / RECIPIENT
    "sessions_practitioner_id_fkey",
    "practitioner_notifications_practitioner_id_fkey",
    "studio_calendar_reservations_practitioner_id_fkey",
    // CLINICAL PERFORMER PROVENANCE
    "sessions_performed_by_practitioner_id_fkey",
    "sessions_aftercare_and_risks_explained_by_fkey",
    // DOMAIN SUBJECT / OPERATOR — a dropdown-picked staff member, not the actor
    "record_keeping_disinfectants_operator_practitioner_id_fkey",
    // PARENT-SCOPED ACTORS WITHOUT LOCAL STUDIO LINEAGE (recorded residual)
    "electrolysis_entries_deleted_by_fkey",
    "laser_entries_deleted_by_fkey",
    "session_audit_edited_by_practitioner_id_fkey",
  ];

  it.each(UNTOUCHED)("%s is never dropped or redefined", (name) => {
    expect(EXEC).not.toContain(name);
  });

  const UNTOUCHED_COLUMNS = [
    "performed_by_practitioner_id",
    "aftercare_and_risks_explained_by",
    "operator_practitioner_id",
    "edited_by_practitioner_id",
  ];

  it.each(UNTOUCHED_COLUMNS)("%s never appears in an executable statement", (col) => {
    expect(EXEC).not.toContain(col);
  });

  it("never touches auth.users provenance", () => {
    // import_batches.created_by / voided_by and
    // imported_treatment_memories.imported_by / voided_by reference auth.users,
    // NOT practitioners. Retargeting them at practitioners would be a
    // different — and wrong — migration.
    expect(EXEC).not.toMatch(/auth\.users/);
    expect(EXEC).not.toMatch(/alter table public\.import_batches/);
    expect(EXEC).not.toMatch(/alter table public\.imported_treatment_memories\b/);
  });

  it("never touches appointment_audit.actor_id, the polymorphic actor namespace", () => {
    // 0174's actor_practitioner_id is the typed practitioner correlation and is
    // already composite + RESTRICT. actor_id spans practitioner/client/system
    // and is not a practitioner FK gap.
    expect(EXEC).not.toMatch(/alter table public\.appointment_audit/);
  });

  it("does not re-litigate the 0174 appointment actor boundary", () => {
    expect(EXEC).not.toMatch(/alter table public\.appointments\b/);
  });
});

describe("0179 — no business-row mutation, no backfill", () => {
  it("contains no INSERT, UPDATE or DELETE against a business table", () => {
    expect(EXEC).not.toMatch(/\binsert\s+into\b/i);
    expect(EXEC).not.toMatch(/\bupdate\s+public\./i);
    expect(EXEC).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("performs no attribution backfill", () => {
    // The backfill rule: PROVABLE may populate, AMBIGUOUS stays NULL. Every
    // populated actor value already carries authoritative evidence and no NULL
    // can be reconstructed without forbidden inference, so 0179 populates
    // nothing at all.
    expect(EXEC).not.toMatch(/coalesce\s*\(/i);
    expect(EXEC).not.toMatch(/\bset\s+[a-z_]+\s*=\s*\(/i);
  });

  it("never makes an actor column NOT NULL", () => {
    // Nullable truth is preserved: a row with no practitioner actor (system,
    // client or public origin) must stay representable.
    expect(EXEC).not.toMatch(/set not null/i);
  });

});

// ---------------------------------------------------------------------------
// VALIDATION IS MANDATORY AND FAILS CLOSED.
//
// THE BINDING RULE:  0179 committing successfully IMPLIES all 39 constraints
// are validated. NOT VALID is the ADD-CONSTRAINT lock strategy, never an
// acceptable terminal state — a migration named ACTOR FK INTEGRITY must not be
// recorded as applied while some of its in-scope historical actor relationships
// are structurally unverified.
//
// An earlier revision of 0179 caught `exception when others`, downgraded a
// failed VALIDATE to a WARNING and committed anyway. These assertions exist so
// that fail-open behaviour cannot return unnoticed.
// ---------------------------------------------------------------------------
describe("0179 — validation is mandatory and fails closed", () => {
  const VALIDATION_BLOCK = EXEC.match(/owned constant text\[\]\[\][\s\S]*?end \$\$;/)?.[0] ?? "";

  it("pins its owned constraint list inside the migration", () => {
    expect(VALIDATION_BLOCK).not.toBe("");
  });

  it("adds every constraint NOT VALID — the lock strategy, not the terminal state", () => {
    const added = EXEC.match(/add constraint [a-z0-9_]+\s+foreign key[\s\S]*?;/g) ?? [];
    expect(added.length).toBe(39);
    for (const a of added) expect(a).toMatch(/not valid;$/);
  });

  it("puts EVERY constraint it creates into the mandatory validation path", () => {
    const created = [...EXEC.matchAll(/add constraint ([a-z0-9_]+)\s+foreign key/g)].map((m) => m[1]);
    expect(created).toHaveLength(39);
    expect(new Set(created).size).toBe(39);
    // Not one of them may be created and then left out of validation.
    for (const name of created) expect(VALIDATION_BLOCK).toContain(name);
  });

  it("validates by pinned name, not by a LIKE pattern that could sweep in other migrations' constraints", () => {
    expect(VALIDATION_BLOCK).toMatch(/validate constraint/);
    expect(VALIDATION_BLOCK).not.toMatch(/like\s+'%/i);
    // A wrong-sized list is a hard error rather than a partial pass.
    expect(VALIDATION_BLOCK).toMatch(/n_owned\s*<>\s*39/);
  });

  it("cannot swallow a validation failure — no `exception when others`, no warning downgrade", () => {
    expect(EXEC).not.toMatch(/exception\s+when\s+others/i);
    expect(EXEC).not.toMatch(/raise\s+warning/i);
  });

  it("catches ONLY foreign_key_violation, so every other error class propagates", () => {
    // Lock timeout, deadlock, permission failure, catalog error and any
    // unexpected SQL error must abort the apply immediately.
    const handlers = [...EXEC.matchAll(/exception\s+when\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) expect(h).toBe("foreign_key_violation");
  });

  it("aborts the transaction when any in-scope constraint failed to validate", () => {
    // foreign_key_violation is collected only to report EVERY dirty
    // relationship in one pass; the migration then raises and rolls back.
    expect(VALIDATION_BLOCK).toMatch(/raise\s+exception[\s\S]*?0179 ABORTED[\s\S]*?cross-studio historical rows/);
  });

  it("treats a missing constraint as a hard error, never a silent skip", () => {
    expect(VALIDATION_BLOCK).toMatch(/was never created/);
  });

  it("re-proves the postcondition from the catalog before succeeding", () => {
    // Success is asserted from pg_constraint.convalidated, not from the loop
    // merely appearing to have run.
    expect(VALIDATION_BLOCK).toMatch(/not con\.convalidated/);
    expect(VALIDATION_BLOCK).toMatch(/still NOT VALID after validation/);
  });

  it("has no successful terminal path that leaves an 0179 FK NOT VALID", () => {
    // Every `not valid;` clause in executable SQL is an ADD CONSTRAINT. There
    // is no branch that reaches COMMIT while a constraint is still unvalidated.
    // (The one other "NOT VALID" in EXEC is the abort message's own text.)
    const notValidClauses = EXEC.match(/not valid;/gi) ?? [];
    expect(notValidClauses).toHaveLength(39);
    expect(EXEC.trim().endsWith("commit;")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LOCK FOOTPRINT — validation must finish before any superseded constraint is
// dropped.
//
// Postgres holds every table lock until the transaction ends, so a strong lock
// taken early is held for the rest of the migration. An earlier revision of
// 0179 dropped each old constraint immediately before adding its replacement,
// which put DROP CONSTRAINT's lock on many central tables at the START of the
// migration and held it across all 39 validation scans. The order is now
// ADD (not valid) -> VALIDATE 39 -> DROP superseded, so the scans happen before
// the strongest locks are taken. These assertions pin that order.
// ---------------------------------------------------------------------------
describe("0179 — validation precedes superseded-constraint cleanup", () => {
  const idxValidate = EXEC.indexOf("validate constraint");
  const idxFirstDrop = EXEC.indexOf("drop constraint");
  const idxAdd = EXEC.indexOf("add constraint");

  it("orders the migration ADD -> VALIDATE -> DROP", () => {
    expect(idxAdd).toBeGreaterThanOrEqual(0);
    expect(idxValidate).toBeGreaterThan(idxAdd);
    expect(idxFirstDrop).toBeGreaterThan(idxValidate);
  });

  it("drops NO superseded constraint before mandatory validation has run", () => {
    // Every drop in the file must sit after the validation statement.
    const drops = [...EXEC.matchAll(/drop constraint if exists ([a-z0-9_]+);/g)];
    expect(drops.length).toBe(39);
    for (const d of drops) expect(d.index!).toBeGreaterThan(idxValidate);
  });

  it("aborts before cleanup — the raise is between validation and the first drop", () => {
    const idxAbort = EXEC.indexOf("0179 ABORTED");
    expect(idxAbort).toBeGreaterThan(idxValidate);
    expect(idxAbort).toBeLessThan(idxFirstDrop);
  });

  it("performs no historical scan after cleanup begins", () => {
    // The only `validate constraint` occurrences must precede every drop.
    const validates = [...EXEC.matchAll(/validate constraint/g)];
    for (const v of validates) expect(v.index!).toBeLessThan(idxFirstDrop);
  });

  it("validates the client_clinical_notes candidate BEFORE dropping its old CASCADE constraint", () => {
    const idxCandidateAdd = EXEC.indexOf(
      "add constraint client_clinical_notes_practitioner_same_studio_0179",
    );
    const idxCandidateInValidation = EXEC.indexOf(
      "'client_clinical_notes_practitioner_same_studio_0179'",
    );
    const idxOldDrop = EXEC.indexOf(
      "drop constraint if exists client_clinical_notes_practitioner_same_studio;",
    );
    expect(idxCandidateAdd).toBeGreaterThanOrEqual(0);
    // It is one of the mandatory 39.
    expect(idxCandidateInValidation).toBeGreaterThan(idxCandidateAdd);
    expect(idxCandidateInValidation).toBeLessThan(idxValidate);
    // Old CASCADE constraint is retired only after validation.
    expect(idxOldDrop).toBeGreaterThan(idxValidate);
  });

  it("restores the canonical client_clinical_notes constraint name", () => {
    // The committed catalog must carry the canonical name, not the candidate.
    expect(EXEC).toMatch(
      /rename constraint client_clinical_notes_practitioner_same_studio_0179\s+to client_clinical_notes_practitioner_same_studio;/,
    );
    const idxRename = EXEC.indexOf("rename constraint");
    const idxOldDrop = EXEC.indexOf(
      "drop constraint if exists client_clinical_notes_practitioner_same_studio;",
    );
    expect(idxRename).toBeGreaterThan(idxOldDrop);
  });

  it("drops exactly the 38 superseded SIMPLE FKs plus the one old composite", () => {
    const dropped = [...EXEC.matchAll(/drop constraint if exists ([a-z0-9_]+);/g)].map((m) => m[1]);
    expect(dropped).toHaveLength(39);
    expect(new Set(dropped).size).toBe(39);
    const composite = dropped.filter((d) => d === "client_clinical_notes_practitioner_same_studio");
    expect(composite).toHaveLength(1);
    expect(dropped.length - composite.length).toBe(38);
  });

  it("proves the final catalog shape inside the migration itself", () => {
    // 58 composite + 9 simple practitioner FKs, none NOT VALID, no candidate
    // name surviving — asserted from pg_constraint, not assumed.
    expect(EXEC).toMatch(/n_composite\s*<>\s*58/);
    expect(EXEC).toMatch(/n_simple\s*<>\s*9/);
    expect(EXEC).toMatch(/n_invalid\s*<>\s*0/);
    expect(EXEC).toMatch(/n_candidate\s*<>\s*0/);
    const idxFinalCheck = EXEC.indexOf("n_composite");
    expect(idxFinalCheck).toBeGreaterThan(idxFirstDrop);
  });

  it("keeps lock_timeout and invents no statement_timeout", () => {
    expect(EXEC).toMatch(/set local lock_timeout = '5s';/);
    expect(EXEC).not.toMatch(/statement_timeout/i);
  });
});

describe("0179 — locking claims are precise, not marketing", () => {
  it("does not claim NOT VALID avoids scanning under ACCESS EXCLUSIVE", () => {
    // The previous header made exactly that claim, which was untrue for the
    // old drop-then-add ordering.
    expect(SQL).not.toMatch(/no table is scanned while an\s*--?\s*ACCESS EXCLUSIVE lock is held/);
    expect(SQL).toMatch(/NOT VALID skips the INITIAL historical scan/);
  });

  it("states plainly that it is not lock-free and still needs a preflight", () => {
    expect(SQL).toMatch(/does not make 0179 lock-free/);
    expect(SQL).toMatch(/bounded read-only preflight/);
  });
});

describe("0179 — recorded residual limitation", () => {
  it("names the parent-scoped actor limitation in the migration itself", () => {
    expect(SQL).toContain(
      "ACTOR FK INTEGRITY — PARENT-SCOPED ACTOR COLUMNS WITHOUT LOCAL STUDIO LINEAGE",
    );
    for (const t of ["electrolysis_entries", "laser_entries", "session_audit"]) {
      expect(SQL).toContain(t);
    }
  });

  it("records that ops_alerts same-studio enforcement is partial", () => {
    // ops_alerts.studio_id is the only nullable studio_id in scope; a composite
    // FK is MATCH SIMPLE, so a global (studio-less) alert is not tenant-checked.
    expect(SQL).toMatch(/ops_alerts\.studio_id is the ONLY nullable studio_id/);
    // Asserted against EXEC, not SQL: the header PROSE explains why MATCH FULL
    // is rejected, so matching raw text here would fail on its own rationale.
    expect(EXEC).not.toMatch(/match full/i);
  });
});
