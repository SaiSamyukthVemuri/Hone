import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";
import { CLIENT_BUDGET_LEVELS } from "@/lib/budget/levels";

// 0183 — client_budget_context.
//
// Source contract for a purely ADDITIVE migration: one new table, its
// constraints, indexes, triggers, RLS and grants. The load-bearing properties
// are (a) one row per client STRUCTURALLY, (b) studio_id is never
// caller-authored, (c) no client-facing role can reach the table, and
// (d) nothing in this file touches treatment_plans.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0183";
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)),
  "utf8",
);
// Comments in this migration deliberately discuss what it does NOT do
// ("does NOT drop treatment_plans.budget_notes"), so every negative assertion
// below runs against executable SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/**
 * The body of one `create or replace function`, bounded at its own `$$;`
 * terminator. A fixed-length slice runs past the function into the next one,
 * which silently changes what an assertion is really counting.
 */
function fnBody(name: string): string {
  const start = CODE.indexOf(`function public.${name}()`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = CODE.indexOf("$$;", start);
  expect(end, `${name} must terminate`).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

/**
 * EXACTLY ONE `create policy` statement, from its header through its own
 * statement-terminating semicolon.
 *
 * A fixed-width window (the previous `slice(start, start + 800)`) runs past
 * the end of one policy into the NEXT one, so assertions nominally about the
 * INSERT policy could be satisfied entirely by UPDATE-policy text — and a
 * regression that stripped INSERT-side actor verification would pass unnoticed.
 *
 * The terminator cannot be found with `indexOf(";")`: a policy body contains
 * `(select auth.uid())` and a multi-line `exists (...)`, so semicolons and
 * parentheses nest. Depth is tracked and the first semicolon at depth ZERO
 * ends the statement.
 *
 * Accepts the policy source rather than the module-level CODE so a mutated
 * fixture can be passed in to prove these assertions are load-bearing.
 */
function policyDefinition(name: string, sql: string = CODE): string {
  const marker = `create policy "${name}"`;
  const start = sql.indexOf(marker);
  expect(start, `policy ${name} must exist`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) return sql.slice(start, i + 1);
  }
  throw new Error(`policy ${name} has no statement-terminating semicolon`);
}

/**
 * The canonical hosted_note names exactly ONE current record, and it is 0183's
 * supersession of 0182. Every other migration named in the note is a
 * historical chain link and must read as one.
 *
 * Counts rather than confirms presence: the surrounding evidence assertions
 * all check a phrase or checksum in isolation, which is precisely why a
 * duplicated transition clause survived them.
 */
function assertSingleCurrentRecord(note: string): void {
  const occurrences = (hay: string, needle: string): number =>
    hay.split(needle).length - 1;

  // A. exactly one CURRENT marker anywhere in the note.
  expect(
    occurrences(note, "as the CURRENT hosted-state record"),
    "the canonical note must name exactly ONE current hosted record",
  ).toBe(1);

  // B. and it is 0183 superseding 0182.
  expect(note).toContain(
    "SUPERSEDES the 0182 record as the CURRENT hosted-state record",
  );

  // C. no historical link is labelled current. Checked generically — by
  // migration number, not by hard-coding "0181" — so a future rewrite cannot
  // mislabel a DIFFERENT migration and slip past.
  //
  // The lookbehind excludes the ONE legitimate form: the supersession clause
  // names the migration being REPLACED ("SUPERSEDES the 0182 record as the
  // CURRENT hosted-state record"), which is correct English for the handoff.
  // Any other "the NNNN record as the CURRENT" is a stale label.
  const mislabelled = [
    ...note.matchAll(/(?<!SUPERSEDES )the (\d{4}) record as the CURRENT/g),
  ].map((m) => m[1]);
  expect(
    mislabelled,
    `historical record(s) wrongly labelled CURRENT: ${mislabelled.join(", ")}`,
  ).toEqual([]);

  // D/E. the chain is still carried forward, oldest link included.
  expect(note).toContain("0181_multi_studio_command_authority.sql");
  expect(note).toContain(
    "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f",
  );
  expect(note).toContain(
    "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
  );

  // F. exactly one chain-forward transition.
  expect(
    occurrences(note, "CARRIES THE FULL CHECKSUM CHAIN FORWARD"),
    "the note must declare the chain-forward transition exactly once",
  ).toBe(1);
}

describe("0183: file and numbering", () => {
  it("carries the version exactly once", () => {
    // 0183 is NO LONGER the repository maximum — 0184 (its least-privilege
    // repair) now is, and per CLAUDE.md only the CURRENT maximum's own test
    // may assert isRepoMax. The "nothing above me" tripwire is served
    // centrally by tests/migrations/0184-*.test.ts.
    expect(countVersion(VERSION)).toBe(1);
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION)).toEqual(["0184"]);
  });

  it("IS applied to production — hosted state is declared, not derived", () => {
    // THE HAND-OFF HAPPENED. This block previously asserted the PRE-APPLY state
    // (hosted still 0182, pending ["0183"]) and was written to go red the
    // moment the rollout ran, so the apply could not be recorded without
    // updating the canonical hosted-state record in the same change. That is
    // exactly what happened: 0183 was applied on 2026-08-17 from the authorized
    // #593 reviewed head, BEFORE any application merge, and this block was
    // flipped in the same change that moved the canonical record.
    //
    // A file on disk still says nothing about what production has applied. The
    // claim below is the DECLARED one, read from
    // docs/production/migration-state.json.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).not.toContain(VERSION);
    // repo != hosted: 0184 is authored and awaiting its own apply gate.
    expect(state.repo_equals_hosted).toBe(false);
    expect(state.pending_migrations).toEqual(["0184"]);
  });

  it("stamps the CURRENT apply as an OPERATOR-OBSERVED window, not a server time", () => {
    // 0183's evidence is stronger than 0182's — a real instant and a captured
    // push exit code — but it is still a CLIENT-SIDE observation from the
    // operator's console. The record must say so, and the qualifier must
    // survive the DERIVATION as well as the file, since
    // `npm run migration:state -- --json` is the documented machine interface.
    const state = migrationState();
    expect(state.hosted_applied_at).toBe("2026-08-17T01:04:02Z");
    expect(state.hosted_applied_at_precision).toMatch(/operator-observed/i);
    expect(state.hosted_applied_at_precision).toMatch(
      /NOT a server-generated migration timestamp/i,
    );
  });

  it("the canonical record carries 0183's apply evidence, honestly", () => {
    const REC = JSON.parse(
      readFileSync(
        path.join(ROOT, "docs/production/migration-state.json"),
        "utf8",
      ),
    );
    // The evidence that was actually captured.
    expect(REC.hosted_note).toContain(
      "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb",
    );
    expect(REC.hosted_note).toMatch(/PUSH EXIT CODE 0 WAS EXPLICITLY CAPTURED/);
    expect(REC.hosted_note).toMatch(/DRY-RUN EXIT 0/);
    expect(REC.hosted_note).toMatch(/0183 \| 0183/);
    // The limitation, stated rather than glossed.
    expect(REC.hosted_note).toMatch(
      /OPERATOR-OBSERVED CLIENT-SIDE WINDOWS, NOT SERVER-GENERATED/i,
    );
    // The known defect in the applied migration is recorded, not hidden.
    expect(REC.hosted_note).toMatch(/MAINTAIN/);
    expect(REC.hosted_note).toMatch(/0184_client_budget_context_least_privilege\.sql/);
    expect(REC.hosted_note).toMatch(/NOT YET APPLIED/i);
    // The chain is carried forward, not dropped.
    for (const priorSha of [
      "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57", // 0182
      "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f", // 0181
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6", // 0171
    ]) {
      expect(REC.hosted_note, priorSha).toContain(priorSha);
    }
  });

  it("names exactly ONE current record — a historical link can never be CURRENT", () => {
    // The 0183 state rewrite spliced a new chain entry in front of 0181 and
    // left the old transition clause attached to it, so the canonical note
    // said "the 0181 record as the CURRENT hosted-state record" a few hundred
    // characters after correctly naming 0183. The structured field was right,
    // so nothing derived was wrong — but the narrative contradicted itself,
    // and this record is what a release decision reads.
    //
    // The earlier evidence assertions could not catch it: every one of them
    // checks a phrase or a checksum in ISOLATION, and all six passed. This is
    // a CONSISTENCY check — it counts, rather than confirming presence.
    const REC = JSON.parse(
      readFileSync(
        path.join(ROOT, "docs/production/migration-state.json"),
        "utf8",
      ),
    );
    assertSingleCurrentRecord(REC.hosted_note);
  });

  it("ANTI-VACUITY: re-labelling a historical link as CURRENT is caught", () => {
    // Mutates a COPY. The real record is never touched.
    const REC = JSON.parse(
      readFileSync(
        path.join(ROOT, "docs/production/migration-state.json"),
        "utf8",
      ),
    );
    expect(() => assertSingleCurrentRecord(REC.hosted_note)).not.toThrow();

    for (const injection of [
      // The exact regression that occurred.
      "the 0181 record as the CURRENT hosted-state record and CARRIES THE FULL CHECKSUM CHAIN FORWARD so no earlier apply record is dropped: ",
      // A different historical link mislabelled.
      "the 0180 record as the CURRENT hosted-state record ",
      // A second chain-forward transition.
      "and CARRIES THE FULL CHECKSUM CHAIN FORWARD again ",
    ]) {
      const mutated = REC.hosted_note.replace(
        "the 0181 record (0181_multi_studio_command_authority.sql",
        injection + "the 0181 record (0181_multi_studio_command_authority.sql",
      );
      expect(mutated).not.toEqual(REC.hosted_note);
      expect(
        () => assertSingleCurrentRecord(mutated),
        `a mislabelled historical record went undetected: ${injection.slice(0, 60)}`,
      ).toThrow();
    }
  });

  it("the APPLIED bytes still hash to the recorded checksum", () => {
    // 0183 is frozen: production ran these exact bytes.
    const raw = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(raw).toBe(
      "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb",
    );
    const executable = createHash("sha256")
      .update(SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"), "utf8")
      .digest("hex");
    expect(executable).toBe(
      "1a968807444b8b7d8d2c93d7f50bf134e613068bfb84c36b3de76615507f778d",
    );
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("opens its own transaction with a bounded lock timeout", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL would emit 25P01 and never arm.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    const beginIdx = CODE.indexOf("begin;");
    const lockIdx = CODE.indexOf("set local lock_timeout");
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
  });

  it("is re-runnable", () => {
    expect(CODE).toContain("create table if not exists public.client_budget_context");
    expect(CODE).toMatch(/drop policy if exists/);
    expect(CODE).toMatch(/drop trigger if exists/);
    expect(CODE).toMatch(/drop constraint if exists/);
  });
});

describe("0183: one row per client, structurally", () => {
  it("makes client_id the PRIMARY KEY — not a unique index bolted on later", () => {
    expect(CODE).toMatch(/client_id uuid primary key,/);
  });

  it("carries the composite tenant-consistency FK to clients (id, studio_id)", () => {
    // The same pattern as client_clinical_notes (0126) / appointments (0151).
    // It makes a row whose studio disagrees with its client's studio
    // structurally unrepresentable, which RLS alone cannot achieve for a
    // practitioner holding memberships in BOTH studios.
    expect(CODE).toMatch(
      /foreign key \(client_id, studio_id\)\s*\n\s*references public\.clients \(id, studio_id\) on delete cascade/,
    );
  });

  it("has no surrogate id column that could permit a second row", () => {
    expect(CODE).not.toMatch(/^\s*id uuid primary key/m);
    expect(CODE).not.toMatch(/gen_random_uuid\(\)/);
  });

  it("cascades from the parent client and studio", () => {
    // The client side cascades through the composite FK asserted above.
    expect(CODE).toContain(
      "references public.clients (id, studio_id) on delete cascade",
    );
    expect(CODE).toContain("references public.studios(id) on delete cascade");
  });

  it("studio-scopes the ACTOR column per the 0179 actor-FK doctrine", () => {
    // A simple FK to practitioners(id) would let a budget edit be attributed
    // to a practitioner from another studio, and would land this column in
    // the 0179 census of simple practitioner FKs — a list whose nine members
    // are all explicitly NON-actor.
    expect(CODE).toMatch(
      /foreign key \(updated_by_practitioner_id, studio_id\)\s*\n\s*references public\.practitioners \(id, studio_id\) on delete restrict/,
    );
    expect(CODE).not.toMatch(/references public\.practitioners\(id\)/);
  });

  it("the actor column is NOT NULL — there is no unattributed writer", () => {
    expect(CODE).toMatch(/updated_by_practitioner_id uuid not null,/);
  });

  it("uses RESTRICT, never SET NULL, on the actor FK", () => {
    // SET NULL on a composite would try to null studio_id, which is NOT NULL;
    // and attribution is durable evidence, so removing the practitioner is
    // refused rather than silently erasing who recorded the budget.
    const line = CODE.slice(
      CODE.indexOf("client_budget_context_updated_by_same_studio_fk"),
    ).slice(0, 240);
    expect(line).toContain("on delete restrict");
    expect(line).not.toContain("set null");
  });
});

describe("0183: the level vocabulary matches the application exactly", () => {
  it("constrains budget_level to the same three values as lib/budget/levels.ts", () => {
    const check = CODE.slice(
      CODE.indexOf("client_budget_context_level_check"),
    );
    for (const level of CLIENT_BUDGET_LEVELS) {
      expect(check).toContain(`'${level}'`);
    }
    // And nothing else: extract the quoted values from the IN list.
    const inList = /budget_level in \(([^)]*)\)/.exec(check);
    expect(inList).not.toBeNull();
    const values = [...(inList?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(values.sort()).toEqual([...CLIENT_BUDGET_LEVELS].sort());
  });

  it("permits NULL — 'no broad level recorded' is a legitimate state", () => {
    expect(CODE).toMatch(/budget_level is null\s*\n?\s*or budget_level in/);
    // The column itself must not be NOT NULL.
    expect(CODE).not.toMatch(/budget_level text not null/);
  });

  it("never invented an 'unlimited' level", () => {
    expect(CODE).not.toMatch(/'unlimited'/);
  });

  it("bounds the free text at the client_personal_notes ceiling", () => {
    expect(CODE).toContain("check (length(budget_notes) <= 20000)");
    expect(CODE).toContain("budget_notes text not null default ''");
  });

  it("does NOT couple the level to the notes", () => {
    // Either may exist without the other; a CHECK requiring one when the
    // other is present would make the UI's independent controls unusable.
    expect(CODE).not.toMatch(/budget_level is not null and .*budget_notes/);
    expect(CODE).not.toMatch(/budget_notes <> '' and .*budget_level/);
  });
});

describe("0183: studio_id is derived, never caller-authored", () => {
  it("fires the trigger on EVERY insert and update, not just on client_id", () => {
    expect(CODE).toMatch(
      /create trigger client_budget_context_set_studio_id\s*\n\s*before insert or update\s*\n/,
    );
    // `update of client_id` would leave a studio_id-only UPDATE unguarded.
    expect(CODE).not.toMatch(/before insert or update of client_id/);
  });

  it("the trigger reads studio_id from the parent clients row", () => {
    const fn = fnBody("client_budget_context_set_studio_id");
    expect(fn).toMatch(
      /select studio_id into new\.studio_id\s*\n\s*from public\.clients\s*\n\s*where id = new\.client_id;/,
    );
    // An unknown client is an exception, not a silent NULL.
    expect(fn).toContain("raise exception");
  });

  it("pins the trigger function's search_path", () => {
    const fn = fnBody("client_budget_context_set_studio_id");
    expect(fn.slice(0, 300)).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("freezes client_id AND created_at on UPDATE, REJECTING rather than silently correcting", () => {
    expect(CODE).toMatch(
      /create trigger client_budget_context_immutable_fields\s*\n\s*before update on public\.client_budget_context/,
    );
    const fn = fnBody("client_budget_context_immutable_fields");
    expect(fn).toContain("new.client_id is distinct from old.client_id");
    expect(fn).toContain("new.created_at is distinct from old.created_at");
    expect(fn.match(/raise exception/g) ?? []).toHaveLength(2);
    // A silent reset would conceal both a caller bug and an attack.
    expect(fn).not.toMatch(/new\.client_id\s*:=\s*old\.client_id/);
    expect(fn).not.toMatch(/new\.created_at\s*:=\s*old\.created_at/);
    expect(fn).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("drops the superseded narrower trigger and function by name", () => {
    // A database that ran an earlier revision of this file must not keep both.
    expect(CODE).toContain(
      "drop trigger if exists client_budget_context_client_id_immutable",
    );
    expect(CODE).toContain(
      "drop function if exists public.client_budget_context_client_id_immutable()",
    );
  });

  it("forces BOTH timestamps on INSERT — `default now()` is not the guarantee", () => {
    // A default applies only when the caller OMITS the column. Measured on
    // this schema before the guard: a direct INSERT supplying created_at and
    // updated_at stored both verbatim.
    expect(CODE).toMatch(
      /create trigger client_budget_context_server_timestamps\s*\n\s*before insert on public\.client_budget_context/,
    );
    const fn = fnBody("client_budget_context_server_timestamps");
    expect(fn).toMatch(/new\.created_at\s*:=\s*now\(\)/);
    expect(fn).toMatch(/new\.updated_at\s*:=\s*now\(\)/);
    expect(fn).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("the immutability trigger sorts BEFORE the derivation triggers", () => {
    // Same-timing triggers fire in NAME order, so a rejected mutation is
    // refused before studio_id is re-derived or updated_at is stamped.
    for (const later of [
      "client_budget_context_set_studio_id",
      "client_budget_context_set_updated_at",
    ]) {
      expect("client_budget_context_immutable_fields" < later).toBe(true);
    }
  });

  it("does NOT freeze the fields that are meant to change", () => {
    // Correcting a budget is the entire point of the table; only identity and
    // creation time are frozen. A blanket "no updates" trigger would break the
    // product.
    const fn = fnBody("client_budget_context_immutable_fields");
    for (const mutable of [
      "budget_level",
      "budget_notes",
      "updated_by_practitioner_id",
    ]) {
      expect(fn).not.toContain(`new.${mutable}`);
    }
    // updated_at must NOT be frozen — set_updated_at() advances it on UPDATE.
    expect(fn).not.toContain("new.updated_at is distinct from old.updated_at");
  });

  it("leaves public.set_updated_at() as the UPDATE-side updated_at authority", () => {
    expect(CODE).toContain("execute function public.set_updated_at()");
  });

  it("maintains updated_at by trigger, not by the caller", () => {
    expect(CODE).toMatch(
      /create trigger client_budget_context_set_updated_at\s*\n\s*before update on public\.client_budget_context/,
    );
    expect(CODE).toContain("execute function public.set_updated_at()");
  });
});

describe("0183: RLS and grants", () => {
  it("enables RLS", () => {
    expect(CODE).toContain(
      "alter table public.client_budget_context enable row level security",
    );
  });

  it("gates select, insert and update on authenticated studio membership", () => {
    for (const op of ["select", "insert", "update"]) {
      expect(CODE).toMatch(new RegExp(`for ${op} to authenticated`));
    }
    expect(CODE).toMatch(
      /public\.is_studio_member\(client_budget_context\.studio_id\)/,
    );
  });

  it("each policy extraction stops at its OWN statement", () => {
    // The boundary proof. Without it, everything below can be satisfied by the
    // adjacent policy's text.
    const insert = policyDefinition("client_budget_context_member_insert");
    const update = policyDefinition("client_budget_context_member_update");
    const select = policyDefinition("client_budget_context_member_select");

    expect(insert).not.toContain("client_budget_context_member_update");
    expect(insert).not.toContain("client_budget_context_member_select");
    expect(update).not.toContain("client_budget_context_member_insert");
    expect(update).not.toContain("client_budget_context_member_select");
    expect(select).not.toContain("client_budget_context_member_insert");

    // Each really is the statement it claims to be, and each terminates.
    expect(insert).toContain("for insert to authenticated");
    expect(update).toContain("for update to authenticated");
    expect(select).toContain("for select to authenticated");
    for (const pol of [insert, update, select]) {
      expect(pol.endsWith(";")).toBe(true);
    }
  });

  it("BOTH write policies VERIFY the actor against auth.uid()", () => {
    // Studio membership alone would let a member attribute an edit to a
    // colleague, or (when nullable) erase attribution entirely. The database
    // derives the actor instead of trusting the caller.
    //
    // Each policy is extracted through its OWN terminating semicolon, so an
    // INSERT-side regression cannot be masked by the UPDATE policy sitting a
    // few lines below it.
    for (const policy of [
      "client_budget_context_member_insert",
      "client_budget_context_member_update",
    ]) {
      const pol = policyDefinition(policy);
      expect(pol, policy).toContain("public.is_studio_member(");
      expect(pol, policy).toContain("from public.practitioners p");
      expect(pol, policy).toContain(
        "p.id = client_budget_context.updated_by_practitioner_id",
      );
      expect(pol, policy).toContain("p.user_id = (select auth.uid())");
      expect(pol, policy).toContain("and p.active");
      expect(pol, policy).toContain(
        "p.studio_id = client_budget_context.studio_id",
      );
    }
  });

  it("ANTI-VACUITY: a bare-membership INSERT policy is CAUGHT, and UPDATE stays green", () => {
    // Mutate a COPY of the migration source: the INSERT policy is "simplified"
    // back to a bare studio-membership check while the UPDATE policy is left
    // fully correct. That is the exact regression the old fixed-width slice
    // could not see — its window ran into the UPDATE policy, which satisfied
    // all four actor assertions on the INSERT policy's behalf.
    const realInsert = policyDefinition("client_budget_context_member_insert");
    const bare =
      'create policy "client_budget_context_member_insert"\n' +
      "  on public.client_budget_context for insert to authenticated\n" +
      "  with check (public.is_studio_member(client_budget_context.studio_id));";
    const mutated = CODE.replace(realInsert, bare);
    expect(mutated).not.toEqual(CODE);

    const mutatedInsert = policyDefinition(
      "client_budget_context_member_insert",
      mutated,
    );
    // The INSERT policy no longer verifies the actor — and we can SEE that,
    // which is the whole point.
    expect(mutatedInsert).not.toContain("from public.practitioners p");
    expect(mutatedInsert).not.toContain("p.user_id = (select auth.uid())");
    expect(mutatedInsert).not.toContain("and p.active");

    // The UPDATE policy is untouched and still fully verified, proving the two
    // are independently bound rather than sharing one window.
    const mutatedUpdate = policyDefinition(
      "client_budget_context_member_update",
      mutated,
    );
    expect(mutatedUpdate).toContain("from public.practitioners p");
    expect(mutatedUpdate).toContain("p.user_id = (select auth.uid())");
    expect(mutatedUpdate).toContain("and p.active");
  });

  it("ANTI-VACUITY: a bare-membership UPDATE policy is CAUGHT, and INSERT stays green", () => {
    const realUpdate = policyDefinition("client_budget_context_member_update");
    const bare =
      'create policy "client_budget_context_member_update"\n' +
      "  on public.client_budget_context for update to authenticated\n" +
      "  using (public.is_studio_member(client_budget_context.studio_id))\n" +
      "  with check (public.is_studio_member(client_budget_context.studio_id));";
    const mutated = CODE.replace(realUpdate, bare);
    expect(mutated).not.toEqual(CODE);

    const mutatedUpdate = policyDefinition(
      "client_budget_context_member_update",
      mutated,
    );
    expect(mutatedUpdate).not.toContain("from public.practitioners p");
    expect(mutatedUpdate).not.toContain("and p.active");

    const mutatedInsert = policyDefinition(
      "client_budget_context_member_insert",
      mutated,
    );
    expect(mutatedInsert).toContain("from public.practitioners p");
    expect(mutatedInsert).toContain("and p.active");
  });

  it("FULLY QUALIFIES the studio comparison — the 0126 tautology bug", () => {
    // 0126 wrote `p.studio_id = studio_id`; because practitioners also has a
    // studio_id column PostgreSQL bound the bare name to the INNER one, making
    // the clause `p.studio_id = p.studio_id` — always true. 0127 had to fix
    // that in production. This file must use the corrected form from the
    // start, everywhere.
    expect(CODE).toContain("p.studio_id = client_budget_context.studio_id");
    expect(CODE).not.toMatch(/p\.studio_id = studio_id/);
    expect(CODE).not.toMatch(/p\.id = updated_by_practitioner_id\b/);
    // And no bare is_studio_member(studio_id) that could bind ambiguously.
    expect(CODE).not.toMatch(/is_studio_member\(studio_id\)/);
  });

  it("the UPDATE policy carries BOTH using and with check", () => {
    // Bounded to its own statement: with a fixed window this could have been
    // satisfied by the SELECT policy's `using` plus the INSERT policy's
    // `with check`, without the UPDATE policy having either.
    const pol = policyDefinition("client_budget_context_member_update");
    expect(pol).toMatch(/using \(/);
    expect(pol).toMatch(/with check \(/);
  });

  it("the SELECT policy is read-only — it carries no with check", () => {
    const pol = policyDefinition("client_budget_context_member_select");
    expect(pol).toMatch(/using \(/);
    expect(pol).not.toMatch(/with check/);
  });

  it("has NO delete policy — clearing is an UPDATE, not a row removal", () => {
    expect(CODE).not.toMatch(/for delete/);
  });

  it("revokes from anon AND service_role explicitly BY NAME", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants to all three roles at create
    // time. This was missed in 0129 (anon) and again in 0164 (service_role).
    expect(CODE).toContain(
      "revoke all on public.client_budget_context from anon",
    );
    expect(CODE).toContain(
      "revoke all on public.client_budget_context from service_role",
    );
  });

  it("grants authenticated exactly select/insert/update and revokes delete/truncate", () => {
    expect(CODE).toContain(
      "grant select, insert, update on public.client_budget_context to authenticated",
    );
    expect(CODE).toContain(
      "revoke delete, truncate on public.client_budget_context from authenticated",
    );
  });

  it("grants NOTHING to service_role", () => {
    expect(CODE).not.toMatch(/grant [^;]*on public\.client_budget_context to service_role/);
  });
});

describe("0183: additive only — no data loss", () => {
  it("issues no DDL or DML against treatment_plans", () => {
    // The table IS named once, in the COMMENT prose that records why the
    // legacy column was left alone — that reference is the point, so this
    // asserts on statements rather than on the substring.
    const statements = CODE.replace(/'[^']*'/g, "''");
    expect(statements).not.toMatch(/treatment_plans/);
    expect(CODE).not.toMatch(/alter table[^;]*treatment_plans/i);
    expect(CODE).not.toMatch(/(from|into|update)\s+public\.treatment_plans/i);
  });

  it("still says WHY the legacy column was not backfilled", () => {
    expect(SQL).toMatch(/NOT backfilled|NO backfill/);
    expect(SQL).toContain("treatment_plans.budget_notes");
  });

  it("performs no backfill and no row mutation whatsoever", () => {
    expect(CODE).not.toMatch(/\binsert into\b/i);
    expect(CODE).not.toMatch(/\bupdate\s+public\./i);
    expect(CODE).not.toMatch(/\bdelete from\b/i);
  });

  it("drops nothing that holds data", () => {
    expect(CODE).not.toMatch(/drop table/i);
    expect(CODE).not.toMatch(/drop column/i);
    expect(CODE).not.toMatch(/alter table [^\n]*drop (?!constraint)/i);
  });

  it("touches no payment or scheduling object", () => {
    for (const forbidden of [
      "appointments",
      "appointment_payments",
      "payment_charge_attempts",
      "stripe",
      "sessions",
    ]) {
      expect(CODE.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("documents the table and the level column", () => {
    expect(CODE).toContain("comment on table public.client_budget_context is");
    expect(CODE).toContain(
      "comment on column public.client_budget_context.budget_level is",
    );
  });
});
