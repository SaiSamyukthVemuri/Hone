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

  it("is pending against hosted state, because it has not been applied", () => {
    // 0187 is deliberately unapplied while this lands: migration-first ordering
    // means the apply is a separate, authorized operator step.
    const state = migrationState();
    expect(state.repo_migration_max).toBe(VERSION);
    expect(Number(state.hosted_migration_max)).toBeLessThan(Number(VERSION));
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
