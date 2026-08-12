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

// ---------------------------------------------------------------------------
// WHEN A SUCCESSOR IS AUTHORED (0180+), THIS BLOCK GOES RED ON PURPOSE.
// Convert the equality below to a FLOOR (`hosted >= 179`) plus "no longer the
// repository maximum", keep the sha256 freeze and the apply facts exactly as
// they are, and let 0180's own test become the single current-state tripwire.
// That is the same hand-off 0178 performed for this file.
// ---------------------------------------------------------------------------
describe("0179 — production truth: APPLIED 2026-08-12", () => {
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );
  const LEDGER = readFileSync(
    join(__dirname, "..", "..", "docs/production/migration-ledger.md"),
    "utf8",
  );

  it("the declared hosted max is 0179 — repository and production agree, nothing pending", () => {
    expect(rec.hosted_migration_max).toBe("0179");
    expect(isRepoMax(rec.hosted_migration_max)).toBe(true);
    expect(versionsAbove(rec.hosted_migration_max)).toEqual([]);
    expect(countVersion("0179")).toBe(1);
  });

  it("the record carries the sha256 of the exact 0179 bytes that were applied", async () => {
    // THE FREEZE. If this hash ever changes, an applied migration has been
    // edited and a recorded production apply fact has been falsified. A future
    // semantic change is 0180+, never a rewrite of these bytes.
    const { createHash } = await import("node:crypto");
    const bytes = readFileSync(join(__dirname, "..", "..", FILE));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("ce9993d86f67d4f5d82c908980f44baf11e404b371cc0611862e0c253cef059a");
    expect(rec.hosted_note).toContain(sha);
  });

  it("the record states the catalog closure 0179 exists to produce", () => {
    expect(rec.hosted_note).toMatch(/58 composite \/ 9 simple \/ 0 NOT VALID/);
    expect(rec.hosted_note).toMatch(/all 39 constraints validated/);
    expect(rec.hosted_note).toMatch(/35 durable actor\/author\/creator relationships are ON DELETE RESTRICT/);
    expect(rec.hosted_note).toMatch(/exactly 4 operational actor/);
  });

  it("the record does NOT claim any business-row mutation was executed", () => {
    expect(rec.hosted_note).toMatch(/ZERO BUSINESS-ROW MUTATION/);
    expect(rec.hosted_note).toMatch(/practitioners 7 -> 7/);
    expect(rec.hosted_note).toMatch(/client_clinical_notes 21 -> 21/);
    expect(rec.hosted_note).toMatch(/NO WILLOW MUTATION/);
    expect(rec.hosted_note).toMatch(/zero attribution backfill/);
  });

  it("the record carries the FULL superseded checksum chain forward", () => {
    // Recording an apply must never drop an earlier frozen apply record.
    for (const sha of [
      "6fc6a85038144933a7091b20b082aba4dcc5987c36c604c1cde52ec01bef234f", // 0178
      "a9c15f1c92a7deb24c8e04dbf123e82806fe35f28be814b84222c1c13ae82744", // 0177
      "4ed5ad84168d6c6f9a8372709b737990af57a5dde08a4e56a7a983308951af20", // 0176
      "7a00f67159a31dcdf90db8a35521ba26f258980b415ddd1aea214e63f4af3ad1", // 0175
      "479dc58dd76d6030bc33bd83fb30b0a7f930ca58330067bb98a3f6c16a949bbc", // 0174
      "04973b15c7b4b5675faa0d4260e29d7e6ccac9fd4a96cd83cbfbea2b90ab97cb", // 0173
      "b89b0d47a70ea2d4a7574bcc4223081cfe1d527394b3ef8b6d4c82bb090f42f1", // 0172
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6", // 0171
    ]) {
      expect(rec.hosted_note).toContain(sha);
    }
  });

  it("the ledger's CURRENT STATE block reconciles repo and hosted at 0179", () => {
    const current = LEDGER.slice(
      LEDGER.indexOf("## Current state"),
      LEDGER.indexOf("## Previous state"),
    );
    expect(current).toContain("post-0179 apply");
    expect(current).toContain("0179_actor_fk_integrity.sql");
    expect(current).toContain("ce9993d86f67d4f5d82c908980f44baf11e404b371cc0611862e0c253cef059a");
    expect(current).toContain("91b81cd35abfbab6686a5dbe7560124fa56c3fea");
    expect(current).toMatch(/hosted == repo/);
    expect(current).toMatch(/0180/);
    expect(current).not.toMatch(/post-0178 apply/);
  });

  it("the ledger carries a 0179 rollout entry with the ordering and census evidence", () => {
    const entry = LEDGER.slice(LEDGER.indexOf("## 0179 — ACTOR FK INTEGRITY"));
    expect(entry).not.toBe("");
    expect(entry).toMatch(/exit code 0/);
    expect(entry).toMatch(/12,920 ms/);
    expect(entry).toMatch(/39 changed \+ 25 unchanged \+\s*\n?3 deferred = 67|39 changed \+ 25 unchanged \+ \*\*?3 deferred/);
    expect(entry).toMatch(/CASCADE/);
    expect(entry).toMatch(/MATCH SIMPLE/);
  });

  it("preserves the 0178 record as frozen historical evidence, heading-only demotion", () => {
    // The former Current state block must survive verbatim as Previous state —
    // recording a new apply never deletes the one it supersedes.
    expect(LEDGER).toContain("## Previous state (verified 2026-08-11, post-0178 apply)");
    expect(LEDGER).toContain("## 0178 — PRACTITIONER IDENTITY + MUTATION BOUNDARY");
    expect(LEDGER).toContain("6fc6a85038144933a7091b20b082aba4dcc5987c36c604c1cde52ec01bef234f");
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

// ---------------------------------------------------------------------------
// DEPLOYMENT-SAFETY TRUTH.
//
// 0179 is deliberately ONE transaction, which is what makes it all-or-nothing.
// The cost of that is real and must be stated: ADD FOREIGN KEY takes SHARE ROW
// EXCLUSIVE on the referencing table and on practitioners, and Postgres holds
// it until COMMIT. SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock
// ordinary INSERT/UPDATE/DELETE take, so writes to a touched table are blocked
// from that table's ADD onward — including throughout validation. VALIDATE's
// own weaker lock does NOT release the locks already held.
//
// Verified locally against PostgreSQL 17: with an ADD-FK transaction held open
// on public.clients, a concurrent UPDATE failed with 55P03 (canceling statement
// due to lock timeout) while a plain SELECT returned normally.
//
// An earlier revision of this header claimed VALIDATE "allows concurrent reads
// and writes". That is false inside this transaction. These assertions keep the
// documentation honest.
// ---------------------------------------------------------------------------
describe("0179 — deployment-safety claims are truthful", () => {
  it("never claims validation runs concurrently with writes", () => {
    // The specific retracted wording, and any close variant, must not return.
    expect(SQL).not.toMatch(/allows concurrent reads and writes/i);
    expect(SQL).not.toMatch(/concurrently with writes/i);
    expect(SQL).not.toMatch(/zero[- ]downtime/i);
    expect(SQL).not.toMatch(/no table is scanned while an\s*--?\s*ACCESS EXCLUSIVE lock is held/);
  });

  it("states that ADD FOREIGN KEY locks are held until COMMIT", () => {
    expect(SQL).toMatch(/SHARE ROW EXCLUSIVE/);
    expect(SQL).toMatch(/remain held until COMMIT/i);
  });

  it("states that ordinary writes are blocked during ADD and VALIDATE", () => {
    expect(SQL).toMatch(/ordinary writes to a table are\s*--?\s*BLOCKED/i);
    expect(SQL).toMatch(/writes to touched tables stay blocked/i);
    // And that VALIDATE's weaker lock does not undo that.
    expect(SQL).toMatch(/does NOT release them/i);
  });

  it("states that plain reads survive until the cleanup tail", () => {
    expect(SQL).toMatch(/Plain reads still work/i);
    expect(SQL).toMatch(/only\s*--?\s*phase that can also block plain READS/i);
  });

  it("requires a controlled write-quiescent production rollout", () => {
    expect(SQL).toMatch(/WRITE-QUIESCENT/);
    expect(SQL).toMatch(/read-only preflight/i);
    expect(SQL).toMatch(/not an ordinary\s*--?\s*mid-traffic apply/i);
  });

  it("describes lock_timeout accurately and adds no statement_timeout", () => {
    // lock_timeout bounds WAITING to acquire, nothing else.
    expect(SQL).toMatch(/bounds how long each statement will WAIT TO ACQUIRE/);
    expect(SQL).toMatch(/does NOT cap the validation scan duration/);
    expect(EXEC).toMatch(/set local lock_timeout = '5s';/);
    expect(EXEC).not.toMatch(/statement_timeout/i);
  });

  it("records the production apply preflight without performing it", () => {
    expect(SQL).toMatch(/PRODUCTION APPLY PREFLIGHT/);
    expect(SQL).toMatch(/read-only historical cross-studio violation census/i);
    expect(SQL).toMatch(/active\/long-running transactions/i);
    // Recorded as documentation only — no executable statement may reach out.
    expect(EXEC).not.toMatch(/dblink|postgres_fdw|copy\s+.*from\s+program/i);
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
