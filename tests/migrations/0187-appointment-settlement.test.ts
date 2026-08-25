import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
} from "./helpers/migration-state";

// 0187 — practitioner-attested appointment settlement (PAY-SETTLE).
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that authority is really re-derived, that history is
// really append-only, and that settlement and card charging really exclude each
// other under concurrency — runs against the migrated database in
// tests/db/appointment-settlement.db.test.ts. Neither is sufficient alone: SQL
// text cannot prove a race, and a behavioural test cannot prove that a grant
// line was WRITTEN rather than inherited from Supabase's create-time defaults.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * add 'card' or 'hone' to the method vocabulary -> the allowlist assertion
//     fails here, and Stripe truth and practitioner attestation have been
//     collapsed into one column;
//   * drop the shared advisory lock from either side -> the lock assertions
//     fail here, and the mutual exclusion silently becomes a convention;
//   * widen a grant, or revoke by name instead of REVOKE ALL -> the privilege
//     assertions fail here, which is the 0129 / 0164 / 0183 failure class.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0187";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by prose: this header discusses
// at length what the migration must NOT do, and names the very values it
// forbids.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

// CODE with every string literal blanked. `comment on ... is '...'` is
// executable SQL, so a word NAMED IN PROSE inside one is indistinguishable from
// a value the migration operates on if you scan CODE alone.
const STATEMENTS = CODE.replace(/'(?:[^']|'')*'/g, "''");

const TABLE = "public.appointment_settlements";

describe("0187 — migration state", () => {
  it("exists exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("is named for what it creates", () => {
    expect(FILE).toBe("0187_appointment_settlement.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so that a future
    // migration does not turn this file red. Whoever adds 0188 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("IS APPLIED to production, and hosted has caught up with the repo", () => {
    // WHAT CHANGED AND WHY THIS WAS REWRITTEN RATHER THAN DELETED. This block
    // asserted the migration-first posture while 0187 sat unapplied: hosted was
    // strictly BELOW repo, and 0187 read as pending. That was true and is now
    // history — 0187 was applied on 2026-08-24 from the exact reviewed #636
    // head, BEFORE that PR merged, and hosted caught up.
    //
    // Derived, never pinned to a literal: whoever adds 0188 changes nothing
    // here, because repo/hosted equality is read from the canonical record
    // rather than from a number typed into this file.
    const state = migrationState();
    expect(state.repo_migration_max).toBe(VERSION);
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.pending_migrations).toEqual([]);
    expect(state.next_free_migration).toBe("0188");
  });
});

describe("0187 — transactional envelope", () => {
  it("opens its own transaction and sets a lock timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms. Order matters: begin first.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("0187 — the money-truth boundary", () => {
  it("the method vocabulary is EXACTLY the five agreed values", () => {
    const check = CODE.match(
      /add constraint appointment_settlements_method_check\s+check \(method in \(([^)]*)\)\)/,
    );
    expect(check).not.toBeNull();
    const values = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(values).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "still_owes",
      "waived",
    ]);
  });

  it("no card / hone / stripe value can enter the vocabulary", () => {
    const check = CODE.match(
      /add constraint appointment_settlements_method_check\s+check \(method in \(([^)]*)\)\)/,
    )![1];
    for (const forbidden of ["card", "hone", "stripe", "paid_card", "paid_hone"]) {
      expect(check).not.toContain(`'${forbidden}'`);
    }
  });

  it("the settlement table carries NO stripe column of any kind", () => {
    // Everything between `create table ... appointment_settlements (` and the
    // closing paren. A stripe identifier here is how an attestation would start
    // impersonating a receipt.
    const body = CODE.slice(
      CODE.indexOf(`create table if not exists ${TABLE}`),
      CODE.indexOf("alter table public.appointment_settlements"),
    );
    expect(body).not.toMatch(/stripe/i);
    expect(body).not.toMatch(/receipt/i);
    expect(body).not.toMatch(/charge_id|payment_intent/i);
  });

  it("writes NO rows: there is no backfill, so UNKNOWN history stays unknown", () => {
    // The only INSERTs in the file sit INSIDE function bodies and therefore run
    // at RPC call time, never during the apply.
    const applyTime = STATEMENTS.split(/\$\$/)
      .filter((_, i) => i % 2 === 0)
      .join("\n");
    expect(applyTime).not.toMatch(/\binsert\s+into\b/i);
    expect(applyTime).not.toMatch(/\bupdate\s+public\./i);
    expect(applyTime).not.toMatch(/\bdelete\s+from\b/i);
    expect(applyTime).not.toMatch(/\btruncate\b/i);
  });

  it("amount ceilings match the charge ledger, so the two cannot disagree", () => {
    expect(CODE).toMatch(/amount_cents >= 0 and amount_cents <= 200000/);
    expect(CODE).toMatch(/check \(currency in \('cad'\)\)/);
  });
});

describe("0187 — the single-truth, append-only laws", () => {
  it("exactly one LIVE settlement per appointment, by partial unique index", () => {
    expect(CODE).toMatch(
      /create unique index if not exists appointment_settlements_one_live_per_appointment\s+on public\.appointment_settlements \(studio_id, appointment_id\)\s+where superseded_at is null/,
    );
  });

  it("a correction chain is a line, not a tree", () => {
    expect(CODE).toMatch(
      /create unique index if not exists appointment_settlements_one_successor_per_row/,
    );
  });

  it("a correction must state a reason, enforced by CHECK", () => {
    expect(CODE).toMatch(/appointment_settlements_supersede_reason_check/);
    expect(CODE).toMatch(/supersedes_id is not null\s+and supersede_reason is not null/);
  });

  it("every non-supersession column is frozen on UPDATE", () => {
    const guard = CODE.slice(
      CODE.indexOf("function public.appointment_settlements_append_only()"),
    );
    for (const col of [
      "studio_id",
      "appointment_id",
      "method",
      "amount_cents",
      "currency",
      "quoted_amount_cents",
      "recorded_by_practitioner_id",
      "recorded_at",
      "note",
      "supersedes_id",
      "supersede_reason",
    ]) {
      expect(guard).toContain(`new.${col} is distinct from old.${col}`);
    }
  });

  it("deletion is refused by a trigger, not merely by a missing grant", () => {
    expect(CODE).toMatch(
      /create trigger appointment_settlements_no_delete\s+before delete on public\.appointment_settlements/,
    );
  });

  it("recorded_at is server-set rather than defaulted", () => {
    const trg = CODE.slice(
      CODE.indexOf("function public.appointment_settlements_server_timestamps()"),
    );
    expect(trg).toMatch(/new\.recorded_at := now\(\)/);
    // And supersession evidence can never arrive on an INSERT.
    expect(trg).toMatch(/new\.superseded_at := null/);
  });
});

describe("0187 — the shared advisory lock", () => {
  it("the key is defined ONCE and every caller uses that definition", () => {
    expect(CODE).toMatch(
      /create or replace function public\.appointment_settlement_lock_key\(/,
    );
    // Nobody may hand-roll the hash: exactly one hashtextextended in the file.
    expect([...CODE.matchAll(/hashtextextended/g)]).toHaveLength(1);
  });

  it("all four commands take the SAME key", () => {
    const takes = [
      ...CODE.matchAll(
        /pg_advisory_xact_lock\(public\.appointment_settlement_lock_key\(/g,
      ),
    ];
    // record, waive, supersede, and the replaced claim command.
    expect(takes).toHaveLength(4);
  });

  it("the claim command resolves its appointment WITHOUT locking, before the row lock", () => {
    const claim = CODE.slice(
      CODE.indexOf(
        "create or replace function public.claim_session_payment_charge_attempt(",
      ),
    );
    const advisory = claim.indexOf("pg_advisory_xact_lock");
    const rowLock = claim.indexOf("for update");
    expect(advisory).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(advisory);
  });

  it("still_owes is excluded from the card-blocking set, deliberately", () => {
    // Bounded to the function BODY. Comments are already stripped from CODE,
    // so the only remaining risk is running past the function into unrelated
    // SQL — which is what made the first draft of this assertion pass for the
    // wrong reason.
    const fn = CODE.slice(
      CODE.indexOf("function public.appointment_has_blocking_settlement("),
    ).split("$$;")[0];
    expect(fn).toContain("'paid_cash'");
    expect(fn).toContain("'waived'");
    expect(fn).not.toContain("'still_owes'");
  });
});

describe("0187 — authority", () => {
  it("every command re-derives the actor from the NAMED studio", () => {
    const calls = [...CODE.matchAll(/public\.session_actor_practitioner\(p_studio_id\)/g)];
    expect(calls).toHaveLength(3);
  });

  it("waiver and correction are owner-gated in SQL, not in the UI", () => {
    for (const fn of ["waive_appointment_fee", "supersede_appointment_settlement"]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split("$$;")[0];
      expect(body).toMatch(/if not public\.is_studio_owner\(p_studio_id\) then/);
      expect(body).toMatch(/'not_owner'/);
    }
  });

  it("the practitioner command refuses a waiver unconditionally", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.record_appointment_settlement("),
    ).split("$$;")[0];
    expect(body).toMatch(/p_method = 'waived'/);
    expect(body).toMatch(/'owner_only'/);
    // And 'waived' is absent from its accepted list.
    const accepted = body.match(/p_method not in \(\s*([^)]*)\)/)![1];
    expect(accepted).not.toContain("waived");
  });

  it("every SECURITY DEFINER function pins an empty or catalog-only search_path", () => {
    const defs = [...CODE.matchAll(/security definer\s+set search_path = ([^\n]+)/g)];
    expect(defs.length).toBeGreaterThanOrEqual(5);
    for (const d of defs) {
      expect(d[1].trim().replace(/;$/, "")).toBe("pg_catalog, pg_temp");
    }
  });
});

describe("0187 — privileges", () => {
  it("the table REVOKEs ALL from all four roles before granting anything", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke all on ${TABLE} from ${role};`);
    }
    // Exactly one grant, and it is SELECT to authenticated.
    const grants = [...CODE.matchAll(new RegExp(`grant [^;]+ on ${TABLE.replace(".", "\\.")} to [^;]+;`, "g"))];
    expect(grants).toHaveLength(1);
    expect(grants[0][0]).toBe(`grant select on ${TABLE} to authenticated;`);
  });

  it("each command revokes EXECUTE from all four roles by name, then grants one", () => {
    for (const sig of [
      "public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)",
      "public.waive_appointment_fee(uuid, uuid, integer, text, boolean)",
      "public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean)",
    ]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
      }
      expect(CODE).toContain(`grant execute on function ${sig} to authenticated;`);
    }
  });

  it("internal helpers and trigger functions are executable by nobody", () => {
    for (const sig of [
      "public.appointment_settlement_lock_key(uuid)",
      "public.appointment_has_live_card_money(uuid, uuid, boolean)",
      "public.appointment_has_blocking_settlement(uuid, uuid)",
      "public.appointment_quoted_amount_cents(uuid, uuid)",
      "public.retire_ready_card_attempts(uuid, uuid, uuid)",
      "public.appointment_settlements_server_timestamps()",
      "public.appointment_settlements_append_only()",
      "public.appointment_settlements_no_delete()",
    ]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(`revoke all privileges on function ${sig} from ${role};`);
      }
      expect(CODE).not.toContain(`grant execute on function ${sig}`);
    }
  });

  it("the REPLACED claim command keeps its service_role-only ACL, asserted not assumed", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(CODE).toContain(
        `revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from ${role};`,
      );
    }
    expect(CODE).toContain(
      "grant execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) to service_role;",
    );
    expect(CODE).not.toMatch(
      /grant execute on function public\.claim_session_payment_charge_attempt\(uuid, uuid, text\) to authenticated/,
    );
  });
});

describe("0187 — the caller cannot choose the service value", () => {
  it("no granted command takes a quoted-price parameter", () => {
    // It was one, and the commands are granted to `authenticated`, so it was
    // forgeable straight through PostgREST into the column FIN-01A divides by.
    for (const fn of [
      "record_appointment_settlement",
      "waive_appointment_fee",
      "supersede_appointment_settlement",
    ]) {
      const sig = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split(")")[0];
      expect(sig).not.toMatch(/quoted/i);
    }
    expect(CODE).not.toMatch(/p_quoted_amount_cents/);
  });

  it("every insert DERIVES the snapshot from the same helper", () => {
    // CALL SITES only — the definition, the revoke block and the comment all
    // name it too, and counting those would pass for the wrong reason.
    const calls = [
      ...CODE.matchAll(
        /public\.appointment_quoted_amount_cents\(\s*(?:p_studio_id, p_appointment_id|p_studio_id, v_old\.appointment_id)\s*\)/g,
      ),
    ];
    // record, waive, supersede: three inserts, one helper.
    expect(calls.length).toBe(3);
  });

  it("the price law is stated ONCE, in SQL, and fails closed on ambiguity", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.appointment_quoted_amount_cents("),
    ).split("$$;")[0];
    // Studio-local date, never UTC and never a caller's.
    expect(fn).toMatch(/now\(\) at time zone st\.timezone/);
    // Normalized service-name match, the linkage client_pricing has always used.
    expect(fn).toMatch(/lower\(btrim\(cp\.service_name\)\) = lower\(btrim\(v_service_name\)\)/);
    // Only rows already in effect.
    expect(fn).toMatch(/cp\.effective_from <= v_today/);
    // A zero/negative custom price is "none recorded", never "charge nothing".
    expect(fn).toMatch(/cp\.price_cents > 0/);
    // Equally-current disagreement refuses rather than picking.
    expect(fn).toMatch(/if v_distinct > 1 then\s+return null;/);
    // An explicit menu 0 is authoritative; a NULL price is not.
    expect(fn).toMatch(/if v_service_price = 0 then\s+return 0;/);
  });
});

describe("0187 — a prepared card charge does not dead-end settlement", () => {
  it("retirement uses the EXISTING lifecycle and invents no status", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.retire_ready_card_attempts("),
    ).split("$$;")[0];
    expect(fn).toMatch(/set status = 'cancelled'/);
    expect(fn).toMatch(/cancelled_at = now\(\)/);
    expect(fn).toMatch(/cancelled_by_practitioner_id = p_practitioner_id/);
    expect(fn).toMatch(/cancelled_reason = '/);
    // The status vocabulary is untouched.
    expect(CODE).not.toMatch(/payment_charge_attempts_status_check/);
  });

  it("ONLY ready is retired — money in flight and money moved are not", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.retire_ready_card_attempts("),
    ).split("$$;")[0];
    expect(fn).toMatch(/and a\.status = 'ready'/);
    // Re-asserted on the UPDATE itself against a concurrent advance.
    expect(fn).toMatch(/and t\.status = 'ready'/);
    for (const forbidden of ["pending_stripe", "succeeded", "failed", "blocked"]) {
      expect(fn).not.toContain(`'${forbidden}'`);
    }
    // Nothing is deleted, and no money/card/Stripe column is WRITTEN. Scoped to
    // the SET clause: the WHERE clause legitimately READS
    // stripe_payment_intent_id and charged_at, because that is how a row
    // carrying execution evidence is excluded from retirement.
    expect(fn).not.toMatch(/delete\s+from/i);
    const setClause = fn.slice(fn.indexOf("set status ="), fn.indexOf("from target"));
    expect(setClause).not.toMatch(/amount_cents|stripe_|signature|charged_at/i);
  });

  it("EVERY refusal is decided BEFORE retirement, in all three commands", () => {
    // THE ORDERING LAW. A refusal is a plain `return query` — a normal return,
    // which COMMITS — so retiring first and refusing afterwards silently
    // cancelled a prepared charge and then reported that nothing was recorded.
    // Retirement is now the LAST thing before the insert.
    for (const fn of [
      "record_appointment_settlement",
      "waive_appointment_fee",
      "supersede_appointment_settlement",
    ]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split("$$;")[0];
      const lock = body.indexOf("pg_advisory_xact_lock");
      const cardMoney = body.indexOf("appointment_has_live_card_money");
      const quoted = body.indexOf("v_quoted :=");
      const retire = body.indexOf("retire_ready_card_attempts");
      const insert = body.indexOf("insert into public.appointment_settlements");

      expect(lock).toBeGreaterThan(0);
      expect(cardMoney).toBeGreaterThan(lock);
      expect(quoted).toBeGreaterThan(cardMoney);
      expect(retire).toBeGreaterThan(quoted);
      expect(insert).toBeGreaterThan(retire);
    }
  });

  it("an existing settlement is DETECTED, not inferred from a unique conflict", () => {
    // Inferring it from ON CONFLICT would mean the retirement had already run.
    for (const fn of ["record_appointment_settlement", "waive_appointment_fee"]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split("$$;")[0];
      const detect = body.indexOf("t.superseded_at is null");
      const retire = body.indexOf("retire_ready_card_attempts");
      expect(detect).toBeGreaterThan(0);
      expect(retire).toBeGreaterThan(detect);
    }
  });

  it("a resolved price outside the column's domain is a CLOSED refusal", () => {
    for (const fn of [
      "record_appointment_settlement",
      "waive_appointment_fee",
      "supersede_appointment_settlement",
    ]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split("$$;")[0];
      expect(body).toMatch(
        /if v_quoted is not null and \(v_quoted < 0 or v_quoted > 200000\) then/,
      );
      // Never clamped to the ceiling, and never nulled to slip past the CHECK:
      // one fabricates the service value, the other claims it was unresolvable.
      expect(body).not.toMatch(/v_quoted := 200000/);
      expect(body).not.toMatch(/least\(v_quoted/);
    }
  });

  it("the snapshot is derived ONCE per command and the SAME value is stored", () => {
    for (const fn of [
      "record_appointment_settlement",
      "waive_appointment_fee",
      "supersede_appointment_settlement",
    ]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}(`),
      ).split("$$;")[0];
      // Pricing is ordinary mutable data: two calls could validate one number
      // and store another.
      expect(
        [...body.matchAll(/appointment_quoted_amount_cents\(/g)],
      ).toHaveLength(1);
      expect(body).toMatch(/\n    v_quoted,/);
    }
  });

  it("a ready row carrying execution evidence is never retired", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.retire_ready_card_attempts("),
    ).split("$$;")[0];
    expect(fn).toMatch(/a\.stripe_payment_intent_id is null/);
    expect(fn).toMatch(/a\.charged_at is null/);
    // And re-asserted on the UPDATE itself.
    expect(fn).toMatch(/t\.stripe_payment_intent_id is null/);
    expect(fn).toMatch(/t\.charged_at is null/);
  });

  it("the CARD claim path retires nothing", () => {
    // Bounded to the function BODY: the revoke block and the comments below it
    // name the helper, and an unbounded slice would run into them.
    const claim = CODE.slice(
      CODE.indexOf("create or replace function public.claim_session_payment_charge_attempt("),
    ).split("$$;")[0];
    expect(claim).not.toMatch(/retire_ready_card_attempts/);
    // It refuses instead, leaving the row exactly as it found it.
    expect(claim).toMatch(/'settled_externally'/);
  });
});

describe("0187 — the webhook joins the mutex", () => {
  const fn = () =>
    CODE.slice(
      CODE.indexOf("create or replace function public.reconcile_card_payment_succeeded("),
    ).split("$$;")[0];

  it("takes the SHARED key, advisory before row lock", () => {
    const body = fn();
    const advisory = body.indexOf("pg_advisory_xact_lock");
    const rowLock = body.indexOf("for update");
    expect(advisory).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(advisory);
    expect(body).toMatch(/public\.appointment_settlement_lock_key\(/);
  });

  it("checks the blocking settlement BEFORE the status branches", () => {
    // A settlement RETIRES the prepared row, so status-first would report
    // terminal_mismatch and hide the real situation from whoever reads the
    // alert. Both refuse to create money; only this order says why.
    const body = fn();
    const settlement = body.indexOf("appointment_has_blocking_settlement");
    const succeededBranch = body.indexOf("v_row.status = 'succeeded'");
    const terminalBranch = body.indexOf("v_row.status in ('failed'");
    expect(settlement).toBeGreaterThan(0);
    expect(succeededBranch).toBeGreaterThan(settlement);
    expect(terminalBranch).toBeGreaterThan(settlement);
  });

  it("REFUSES rather than mutating when the visit was settled externally", () => {
    const body = fn();
    const conflictAt = body.indexOf("'settled_externally_conflict'");
    const updateAt = body.indexOf("update public.payment_charge_attempts");
    expect(conflictAt).toBeGreaterThan(0);
    // The refusal returns before the only write in the function.
    expect(updateAt).toBeGreaterThan(conflictAt);
    expect(body.slice(conflictAt, updateAt)).not.toMatch(/update\s+public\./);
  });

  it("still only ever moves ready/pending_stripe to succeeded", () => {
    const body = fn();
    expect(body).toMatch(/set status = 'succeeded'/);
    expect(body).toMatch(/and t\.status in \('ready', 'pending_stripe'\)/);
    // It never writes any other status, and never deletes.
    expect(body).not.toMatch(/status = '(failed|cancelled|blocked|ready|pending_stripe)'\s*,/);
    expect(body).not.toMatch(/delete\s+from/i);
  });

  it("is service_role only — it is the writer that makes money", () => {
    const sig = "public.reconcile_card_payment_succeeded(uuid, text, text)";
    for (const role of ["public", "anon", "authenticated"]) {
      expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
    }
    expect(CODE).toContain(`grant execute on function ${sig} to service_role;`);
    expect(CODE).not.toMatch(
      /grant execute on function public\.reconcile_card_payment_succeeded\(uuid, text, text\) to authenticated/,
    );
  });

  it("ALL THREE money-relevant commands share ONE key definition", () => {
    // settlement x3, claim, reconcile.
    const takes = [
      ...CODE.matchAll(
        /pg_advisory_xact_lock\(\s*\n?\s*public\.appointment_settlement_lock_key\(/g,
      ),
    ];
    expect(takes).toHaveLength(5);
    // And still exactly one place computes the hash.
    expect([...CODE.matchAll(/hashtextextended/g)]).toHaveLength(1);
  });
});

describe("0187 — tenancy is structural", () => {
  it("every relation on the table is a same-studio composite FK", () => {
    for (const fk of [
      "appointment_settlements_appointment_same_studio_fk",
      "appointment_settlements_actor_same_studio_fk",
    ]) {
      expect(CODE).toContain(fk);
    }
    expect(CODE).toMatch(
      /foreign key \(appointment_id, studio_id\)\s+references public\.appointments \(id, studio_id\)/,
    );
    expect(CODE).toMatch(
      /foreign key \(recorded_by_practitioner_id, studio_id\)\s+references public\.practitioners \(id, studio_id\)/,
    );
  });

  it("RLS is enabled with exactly one SELECT policy and no write policy", () => {
    expect(CODE).toContain(`alter table ${TABLE} enable row level security;`);
    const policies = [...CODE.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
    expect(policies).toEqual(["appointment_settlements_member_select"]);
    expect(CODE).toMatch(/for select to authenticated/);
    expect(CODE).toMatch(
      /using \(public\.is_studio_member\(appointment_settlements\.studio_id\)\)/,
    );
  });
});

describe("0187 — the file is frozen once applied", () => {
  it("carries a stable digest so a later edit is visible", () => {
    const digest = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// CURRENT HOSTED STATE — 0187 OWNS IT NOW
// ===========================================================================
//
// Inherited from 0186's file at the apply hand-off. Whichever migration is the
// applied head owns these facts; a superseded migration's file must not keep
// deciding them, or it has to be rewritten on every future apply.
//
// Deliberately small. This block records WHAT PRODUCTION HAS RUN and nothing
// else: it does not police the wording of the record's prose, and it makes no
// claim about email, SMS or cron, none of which is needed to establish hosted
// migration state.

function canonicalRecord(): {
  hosted_migration_max: string;
  /** NULLABLE — null right now, because no SERVER apply timestamp was captured. */
  hosted_applied_at: string | null;
  hosted_applied_at_precision: string;
  hosted_note: string;
} {
  return JSON.parse(
    readFileSync(path.join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
}

/**
 * THE ONE DELIMITER between the 0187 head record and the frozen 0186 record it
 * carries. The carried record contains this same phrase (0186 carried its own
 * chain forward), so the FIRST occurrence is the boundary.
 */
const CARRIED_RECORD_BOUNDARY =
  "CARRIES THE FULL CHECKSUM CHAIN FORWARD so no earlier apply record is dropped: ";

/** The phrase a current-record claim is made with. Counted, never merely found. */
const CURRENT_RECORD_PHRASE = "as the CURRENT hosted-state record";
/** Captures WHICH record an active supersession names. */
const SUPERSESSION = /SUPERSEDES the (\d{4}) record as the CURRENT hosted-state record/g;

/**
 * sha256 of the ENTIRE `hosted_note` as it stood on this PR's production base,
 * f9ad0f727503ec7aaa6208aa4aa7e5c84ad5eb1e — i.e. the complete frozen 0186
 * record — 13,269 UTF-8 bytes — covering 0185, 0184, 0183, 0182, 0181, 0180,
 * 0179, 0178, 0177, 0176, 0175, 0174, 0173, 0172 and the 0171 tail with every
 * checksum and the exact ordering.
 *
 * Derived mechanically: `git show <base>:docs/production/migration-state.json`,
 * parse `hosted_note`, sha256 the exact UTF-8 bytes. Not copied from prose, not
 * taken from this branch's own suffix, no whitespace normalisation.
 */
const CARRIED_0186_NOTE_SHA256 =
  "bd8846224fa42596dd98efae112dd2e796611493a0c6a01c5db0f2daed5c757f";

describe("0187 — current hosted state", () => {
  it("is the APPLIED production head", () => {
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(canonicalRecord().hosted_migration_max).toBe(VERSION);
  });

  it("hosted == repo, nothing pending, next free 0188 and UNCLAIMED", () => {
    // All four are DERIVED repo-side facts read from the canonical utility, so
    // whoever adds 0188 moves the last assertion by adding a file, not by
    // editing a number here.
    const state = migrationState();
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.pending_migrations).toEqual([]);
    expect(state.next_free_migration).toBe("0188");
    expect(state.versions).not.toContain("0188");
  });

  it("NO SERVER APPLY TIMESTAMP was captured, and the window is not passed off as one", () => {
    // THE PRECISION LAW. `hosted_applied_at` stays null because no
    // server-generated apply instant was ever read. An operator-observed
    // client-side window WAS captured, and it lives in the precision field
    // where it is explicitly labelled — never in `hosted_applied_at`, which a
    // future reader would take for server time.
    const rec = canonicalRecord();
    expect(rec.hosted_applied_at).toBeNull();
    expect(migrationState().hosted_applied_at).toBeNull();

    const p = rec.hosted_applied_at_precision;
    expect(p).toContain("NO SERVER-GENERATED APPLY TIMESTAMP WAS CAPTURED");
    expect(p).toContain("OPERATOR-OBSERVED CLIENT-SIDE WINDOW");
    expect(p).toContain("2026-08-24T23:36:31.509Z");
    expect(p).toContain("2026-08-24T23:36:51.291Z");
    expect(p).toContain("19.782 seconds");
    // ...and it says, in as many words, that the window must not be promoted.
    expect(p).toContain("NOT a server-side apply time");
  });

  it("NEGATIVE CONTROL: promoting the window into hosted_applied_at is refused", () => {
    // Codex's shape, applied to this record: the failure mode is not a missing
    // value, it is a PLAUSIBLE one. Mutates a copy; the real record is never
    // touched.
    const rec = canonicalRecord();
    const poisoned = { ...rec, hosted_applied_at: "2026-08-24T23:36:51.291Z" };
    expect(poisoned.hosted_applied_at).not.toBeNull();
    // The live record must never look like that.
    expect(rec.hosted_applied_at).toBeNull();
    expect(rec.hosted_applied_at).not.toBe("2026-08-24T23:36:51.291Z");
    expect(rec.hosted_applied_at).not.toBe("2026-08-24T23:36:31.509Z");
  });

  it("the canonical record is 0187's, and carries its production checksum", () => {
    const rec = canonicalRecord();
    const digest = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(digest).toBe(
      "0201f9b8f9e2ca7c5c8f9c702bc020f6bfd5a4046c0490ae3d7be495509e5dc0",
    );
    expect(Buffer.byteLength(SQL, "utf8")).toBe(98309);
    expect(rec.hosted_note).toContain(digest);
    expect(rec.hosted_note).toContain(`${FILE} APPLIED to production`);
  });

  it("records the apply ORDERING truthfully: applied BEFORE the merge existed", () => {
    // The one claim a later reader could most easily invert. 0187 was applied
    // from the reviewed head; the merge commit came afterwards.
    const note = canonicalRecord().hosted_note;
    expect(note).toContain("eb7e824031fb715f23b0c6da6def4e7ea97fc4de");
    expect(note).toContain("APPLIED BEFORE #636 MERGED");
    expect(note).toContain("f9ad0f727503ec7aaa6208aa4aa7e5c84ad5eb1e");
    expect(note).toContain("PUSH EXIT CODE 0 EXPLICITLY CAPTURED");
    expect(note).toContain("DRY-RUN EXIT 0");
  });

  it("carries the earlier apply records forward, unedited", () => {
    // THE INTEGRITY BOUNDARY IS THE DIGEST, NOT AN ENUMERATION. Deleting a
    // whole carried clause drops that record's checksum while every individual
    // `toContain` anchor survives, so an enumeration passes on a chain that is
    // no longer intact. `toContain` is also order-blind.
    //
    // The expected value is the sha256 of the ENTIRE hosted_note as it stood on
    // this PR's production base, f9ad0f72 — derived mechanically from that
    // commit, not transcribed.
    const note = canonicalRecord().hosted_note;
    const at = note.indexOf(CARRIED_RECORD_BOUNDARY);
    expect(at, "the note carries no 0186 record boundary").toBeGreaterThan(-1);
    const carried = note.slice(at + CARRIED_RECORD_BOUNDARY.length);

    // BYTES, NOT CHARACTERS. The carried record contains em dashes and curly
    // quotes, so String.length would under-report the UTF-8 encoding.
    expect(Buffer.byteLength(carried, "utf8")).toBe(13269);
    expect(
      createHash("sha256").update(carried, "utf8").digest("hex"),
      "the carried 0186 record is no longer byte-identical to the production-base " +
        "hosted_note: apply history has been edited, truncated or reordered",
    ).toBe(CARRIED_0186_NOTE_SHA256);
  });

  it("THE HEAD NAMES EXACTLY ONE CURRENT RECORD, and it supersedes 0186", () => {
    // THE OTHER HALF OF THE SAME INVARIANT. The digest above freezes the
    // carried SUFFIX; it says nothing about the head, and a bare `toContain`
    // on the supersession phrase says almost nothing either — a second,
    // contradictory claim could sit alongside the real one and both checks
    // would stay green.
    //
    // POSITIONAL, NOT GLOBAL. The count is taken over the HEAD ONLY. Carried
    // history legitimately contains older CURRENT wording — 0186's supersession
    // of 0185, 0185's of 0184, and 0184's of 0183 — which is frozen evidence
    // and must never be rewritten to satisfy a guard.
    const note = canonicalRecord().hosted_note;
    const head = note.slice(0, note.indexOf(CARRIED_RECORD_BOUNDARY));

    expect(
      head.split(CURRENT_RECORD_PHRASE).length - 1,
      "the head must name exactly ONE current hosted-state record",
    ).toBe(1);

    const claims = [...head.matchAll(SUPERSESSION)].map((m) => m[1]);
    expect(claims).toEqual(["0186"]);

    // ...and the global count is deliberately GREATER than one, which is what
    // makes the positional law different from counting occurrences.
    expect(note.split(CURRENT_RECORD_PHRASE).length - 1).toBeGreaterThan(1);
  });

  it("NEGATIVE CONTROL: a second CURRENT claim in the head turns this red", () => {
    // Mutates a copy; the real record is never touched.
    const note = canonicalRecord().hosted_note;
    const at = note.indexOf(CARRIED_RECORD_BOUNDARY);
    const head = note.slice(0, at);
    const real = "SUPERSEDES the 0186 record as the CURRENT hosted-state record";
    expect(head).toContain(real);

    const poisonedHead = head.replace(
      real,
      `${real} and also the 0183 record as the CURRENT hosted-state record`,
    );
    expect(poisonedHead).not.toEqual(head);

    // THE COUNT IS THE PRIMARY LAW, and this is why. The injected claim never
    // says "SUPERSEDES", so the target regex still reports a single, correct
    // ["0186"] — a guard built only on that regex would pass. Counting the
    // PHRASE is what catches a second current-record claim however it is
    // worded.
    expect(poisonedHead.split(CURRENT_RECORD_PHRASE).length - 1).toBe(2);
    expect([...poisonedHead.matchAll(SUPERSESSION)].map((m) => m[1])).toEqual([
      "0186",
    ]);

    // The target check is load-bearing too, for the other mutation: a single
    // claim that names the WRONG record.
    const wrongTarget = head.replace(
      real,
      "SUPERSEDES the 0183 record as the CURRENT hosted-state record",
    );
    expect(wrongTarget.split(CURRENT_RECORD_PHRASE).length - 1).toBe(1);
    expect([...wrongTarget.matchAll(SUPERSESSION)].map((m) => m[1])).toEqual([
      "0183",
    ]);

    // ...while the carried suffix is untouched, which is exactly why the digest
    // alone could never have caught this.
    const poisoned = poisonedHead + note.slice(at);
    const carried = poisoned.slice(
      poisoned.indexOf(CARRIED_RECORD_BOUNDARY) + CARRIED_RECORD_BOUNDARY.length,
    );
    expect(Buffer.byteLength(carried, "utf8")).toBe(13269);
    expect(createHash("sha256").update(carried, "utf8").digest("hex")).toBe(
      CARRIED_0186_NOTE_SHA256,
    );

    // Restored byte-identically -> green again.
    expect(head.split(CURRENT_RECORD_PHRASE).length - 1).toBe(1);
    expect([...head.matchAll(SUPERSESSION)].map((m) => m[1])).toEqual(["0186"]);
  });

  it("NEGATIVE CONTROL: a mid-chain deletion turns the digest red", () => {
    // Remove the whole carried 0180 clause: every checksum anchor an
    // enumeration would list survives, so the enumeration stays green — and the
    // digest does not. Mutates a copy; the real record is never touched.
    const note = canonicalRecord().hosted_note;
    const at = note.indexOf(CARRIED_RECORD_BOUNDARY);
    const carried = note.slice(at + CARRIED_RECORD_BOUNDARY.length);
    const digest = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

    const from = carried.indexOf("the 0180 record (");
    const to = carried.indexOf("the 0179 record (");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const mutated = carried.slice(0, from) + carried.slice(to);

    // It really is the shape an enumeration misses: shorter, 0180's checksum
    // gone, every previously-anchored checksum still present.
    expect(mutated.length).toBeLessThan(carried.length);
    expect(mutated).not.toContain(
      "d5d8271da38588a89e0727ce7a2a5c417ee8e079ad283acdc1fa55f90727eb8d",
    );
    for (const sha of [
      "4041b38653198976233e5bf1ea41b68b349a587ed2c1fa43c251d9c6c629e66e",
      "663a5d826d4c9e610c3bf7ec599dea577772ba521326488add77153f39a14ffc",
      "aa110edadd459e0f11062e3904ea7ad54a54a75c31d9342b762a533ecc07694c",
      "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb",
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
    ]) {
      expect(mutated).toContain(sha);
    }

    // The digest is what actually catches it.
    expect(digest(mutated)).not.toBe(CARRIED_0186_NOTE_SHA256);
    // Restored byte-identically -> green again.
    expect(digest(carried)).toBe(CARRIED_0186_NOTE_SHA256);
  });

  it("NEGATIVE CONTROL: reverting hosted max to 0186 contradicts the record", () => {
    // The single most likely regression in a future edit: the ledger prose
    // advances while the canonical number is left behind, or vice versa. The
    // two must agree, and the note must name the head it claims.
    const rec = canonicalRecord();
    expect(rec.hosted_migration_max).not.toBe("0186");
    expect(migrationState().hosted_migration_max).toBe(rec.hosted_migration_max);
    const stale = { ...rec, hosted_migration_max: "0186" };
    expect(stale.hosted_migration_max).not.toBe(migrationState().repo_migration_max);
  });
});
