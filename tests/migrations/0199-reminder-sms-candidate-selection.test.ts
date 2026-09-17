import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0199 — WAIT S3. Bounded server-side reminder candidate selection.
//
// SOURCE CONTRACT ONLY. Behaviour against a real database belongs in a db test;
// this file proves the shape, the privilege posture and the position in chain.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0199";
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

const CANDIDATES =
  "reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer)";
const UNROUTABLE =
  "reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer)";

describe("0199 position in the chain", () => {
  it("is the repository maximum", () => {
    // Taken over from 0198, per CLAUDE.md: only the CURRENT max asserts this.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is AUTHORED and PENDING — it is NOT applied to production", () => {
    // The ordinary migration-first shape. 0198 keeps the hosted-head claim
    // because it remains the applied head; this file claims only that it is
    // the repository head and awaits its own apply authorization.
    //
    // Whoever applies 0199 moves the equality block: narrow 0198 to a floor
    // the way 0197, 0196 and 0191 were narrowed, and let this file take it.
    const state = migrationState();
    expect(state.pending_migrations).toEqual([VERSION]);
    expect(state.hosted_migration_max).toBe("0198");
    expect(state.repo_equals_hosted).toBe(false);
  });

  it("does not claim the next free number for anything", () => {
    expect(migrationState().next_free_migration).toBe("0200");
  });
});

describe("0199 is read-only and minimal", () => {
  it("creates four functions, one view, and exactly one column", () => {
    // Two read-only selection functions, plus the two that define the
    // canonical SMS destination fact the generated column applies.
    expect((CODE.match(/create or replace function/g) ?? []).length).toBe(4);
    expect((CODE.match(/create or replace view/g) ?? []).length).toBe(1);
    // ONE alter table: the generated column. No new table, no index, no drop.
    expect((CODE.match(/alter table/gi) ?? []).length).toBe(1);
    expect(CODE).toMatch(
      /alter table public\.clients\s+add column sms_phone text\s+generated always as \(public\.sms_normalized_phone\(phone\)\) stored/,
    );
    expect(CODE).not.toMatch(/create table|create index|drop table|drop column/i);
  });

  it("derives the fact — it does not backfill it with a data write", () => {
    // PostgreSQL populates a STORED generated column as part of ADD COLUMN.
    // An UPDATE backfill would be a second definition of the same rule, free
    // to disagree with the expression that maintains it afterwards.
    expect(CODE).not.toMatch(/update public\.clients/i);
  });

  it("writes no data of any kind", () => {
    expect(CODE).not.toMatch(/insert into|update |delete from|truncate/i);
  });

  it("declares both functions STABLE, never VOLATILE", () => {
    expect((CODE.match(/\bstable\b/g) ?? []).length).toBe(2);
    expect(CODE).not.toMatch(/\bvolatile\b/);
  });

  it("opens its own transaction and arms a lock timeout", () => {
    // `supabase db push` does not wrap a file, so a bare SET LOCAL emits 25P01
    // and never arms.
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/set local lock_timeout/);
    expect(SQL).toMatch(/^commit;/m);
  });
});

describe("0199 privilege posture", () => {
  it("revokes EXECUTE from all four roles BY NAME before granting", () => {
    // 0129 leaked to anon and 0164 to service_role by missing one of these.
    for (const fn of [CANDIDATES, UNROUTABLE]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(SQL, `${fn} / ${role}`).toContain(
          `revoke execute on function public.${fn} from ${role};`,
        );
      }
    }
  });

  it("grants EXECUTE to service_role ONLY", () => {
    for (const fn of [CANDIDATES, UNROUTABLE]) {
      expect(SQL).toContain(`grant execute on function public.${fn} to service_role;`);
      expect(SQL).not.toContain(`grant execute on function public.${fn} to authenticated;`);
      expect(SQL).not.toContain(`grant execute on function public.${fn} to anon;`);
      expect(SQL).not.toContain(`grant execute on function public.${fn} to public;`);
    }
  });

  it("pins search_path on every function", () => {
    expect((CODE.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(4);
  });

  it("uses no collation-dependent character class anywhere in normalisation", () => {
    // A bracket RANGE is resolved through the database's collation, so on a
    // non-C collation `[^0-9]` is not guaranteed to be exactly the ten ASCII
    // digits JavaScript removes -- and a parity corpus can only ever exercise
    // the collation it happens to run under, so it cannot catch this. The
    // enumeration has no ordering semantics and is the same set everywhere.
    //
    // Same reason `[[:space:]]` was rejected for the trim set in favour of an
    // explicit chr() list: a STORED generated column must not depend on a
    // property of the cluster it was written on.
    expect(CODE).toContain("'[^0123456789]'");
    expect(CODE).not.toMatch(/\[\^?0-9\]/);
    expect(CODE).not.toContain("[[:space:]]");
    expect(CODE).not.toContain("[[:digit:]]");
    // And the trim set is still enumerated, not a class.
    expect(CODE).toMatch(/btrim\(p_phone, public\.sms_trimmable_whitespace\(\)\)/);
  });

  it("keeps EXECUTE on the normalisation helpers, which is required, not lax", () => {
    // PostgreSQL evaluates a generated column's expression as the role doing
    // the WRITE. Revoking EXECUTE from anon/authenticated does not harden
    // anything — it makes public booking and every practitioner client edit
    // fail with insufficient_privilege. Both helpers are pure text transforms
    // that read no table, so granting EXECUTE discloses nothing.
    for (const fn of ["sms_trimmable_whitespace()", "sms_normalized_phone(text)"]) {
      expect(SQL).toContain(`revoke execute on function public.${fn} from public;`);
      expect(SQL).toContain(
        `grant execute on function public.${fn} to anon, authenticated, service_role;`,
      );
    }
  });

  it("closes the shared base view to every role", () => {
    // The view is security_invoker and reachable only through the SECURITY
    // DEFINER functions; it must add no readable surface of its own.
    expect(CODE).toMatch(/with \(security_invoker = true\)/);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(SQL).toContain(
        `revoke all on public.reminder_sms_eligible_appointments from ${role};`,
      );
    }
  });

  it("adds NO table privilege — 0191's closure of studio_sms_senders holds", () => {
    expect(CODE).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.studio_sms_senders/i);
    expect(CODE).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.appointments/i);
    expect(CODE).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.studios/i);
  });
});

describe("0199 cannot become send authority", () => {
  it("returns NO sender or provider identifier", () => {
    // The reason resolve_active_studio_sms_sender stays the final authority: a
    // caller handed a sid has every incentive to use it instead of
    // re-resolving, which would close the fail-closed window before the claim.
    expect(CODE).not.toContain("messaging_service_sid");
    expect(CODE).not.toContain("phone_number_sid");
    expect(CODE).not.toContain("claim_key");
    expect(CODE).not.toMatch(/lease_generation|last_error_code/);
  });

  it("returns only ids, ordering keys and a count", () => {
    expect(CODE).toContain("returns table (appointment_id uuid, starts_at timestamptz, studio_id uuid)");
    expect(CODE).toContain("returns table (studio_id uuid, candidate_count bigint)");
  });

  it("says so in its own comment, for the next reader", () => {
    expect(SQL).toMatch(/CANDIDATE FILTER ONLY/);
    expect(SQL).toMatch(/does NOT authorise a send/);
    expect(SQL).toMatch(/OPERATOR ALERTING ONLY/);
  });
});

describe("0199 is bounded and deterministic", () => {
  it("caps output regardless of p_limit, on both functions", () => {
    expect(
      (CODE.match(/limit least\(greatest\(coalesce\(p_limit, 50\), 1\), 200\)/g) ?? []).length,
    ).toBe(2);
  });

  it("orders the candidate page by (starts_at, id) — a TOTAL order", () => {
    expect(CODE).toContain("order by a.starts_at asc, a.id asc");
  });

  it("pages by KEYSET, never OFFSET", () => {
    expect(CODE).toMatch(/p_after_starts_at is null/);
    expect(CODE).toMatch(/a\.starts_at = p_after_starts_at and a\.id >/);
    expect(CODE).not.toMatch(/\boffset\b/i);
  });

  it("SEMI-joins the sender table so a broken invariant cannot fan out", () => {
    // A join would duplicate an appointment if one-live-per-studio were ever
    // violated, silently inflating a bounded page.
    expect(CODE).toMatch(/and exists \(\s*select 1\s*from public\.studio_sms_senders/);
    expect(CODE).not.toMatch(/join\s+public\.studio_sms_senders/);
  });

  it("takes a closed kind vocabulary, not a caller-supplied column", () => {
    expect(CODE).toMatch(/p_kind in \('24h', '2h'\)/);
    expect(CODE).not.toMatch(/execute\s+format|quote_ident/i);
  });
});

describe("0199 removes every class of row that would occupy a page without sending", () => {
  it("excludes clients with no phone, no consent, or an opt-out", () => {
    // Same starvation shape as a routing refusal: the route `continue`s these
    // without changing sent/attempt state, so they re-occupy the page forever.
    // Filtering studios but not clients would have left the defect with a
    // different cause.
    expect(CODE).toContain("join public.clients  c  on c.id  = a.client_id");
    // The canonical DB-owned fact, NOT a re-implementation of the parser and
    // NOT the non-null/non-blank test that let malformed phones through.
    expect(CODE).toMatch(/and c\.sms_phone is not null/);
    expect(CODE).not.toMatch(/btrim\(c\.phone\)/);
    expect(CODE).toMatch(/and c\.sms_consent_at is not null/);
    expect(CODE).toMatch(/and c\.sms_opted_out_at is null/);
    // Stated ONCE, in the shared base both functions read.
    expect((CODE.match(/and c\.sms_phone is not null/g) ?? []).length).toBe(1);
    expect((CODE.match(/from public\.reminder_sms_eligible_appointments a/g) ?? []).length).toBe(2);
  });

  it("the client gates are a SNAPSHOT, not authority — the gate still re-reads", () => {
    const send = readFileSync(
      path.join(ROOT, "lib/sms/send-appointment.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, " ");
    // Consent and opt-out change; selection only decides what is worth
    // loading. The live gate is what refuses.
    expect(send).toContain("passesConsentGate({");
    expect(send).toMatch(/sms_opted_out_at/);
    expect(send).toMatch(/sms_consent_at/);
  });
});

describe("0199 complement alerts ROTATE rather than repeating one prefix", () => {
  it("excludes studios that already hold an OPEN routing alert", () => {
    // A stable order plus a bound would return the same first 50 studios on
    // every run, so studios past that prefix would never be reported — the
    // exact invisibility the complement exists to prevent, reproduced inside
    // the fix for it.
    expect(CODE).toMatch(/from public\.ops_alerts oa/);
    expect(CODE).toMatch(/oa\.resolved_at is null/);
    // EXACTLY the event this path records. Matching the whole routing
    // vocabulary meant an unresolved `sms_sender_ambiguous` — a different
    // fault with a different fix — suppressed the not-active alert
    // indefinitely.
    expect(CODE).toContain("oa.event = 'sms_sender_not_active_for_studio'");
    for (const ev of ["sms_sender_ambiguous", "sms_sender_read_failed"]) {
      expect(CODE).not.toContain(`'${ev}'`);
    }
  });

  it("uses the SAME predicate as 0194's dedupe index, so the two agree", () => {
    const idx = readFileSync(
      path.join(ROOT, "supabase/migrations/0194_studio_sms_sender_outbound_lookup.sql"),
      "utf8",
    );
    // 0194: unique (studio_id, event) where resolved_at is null.
    expect(idx).toContain("ops_alerts_sms_routing_open_uniq");
    expect(idx).toContain("where resolved_at is null");
    // 0199 excludes on exactly that condition, so "already reported" here and
    // "already open" there are the same set. Resolving re-arms the studio.
    expect(CODE).toMatch(/oa\.resolved_at is null/);
  });

  it("the complement still reads ops_alerts ONLY to decide what to report", () => {
    // It must not gate sending, selection, or anything else.
    const route = readFileSync(
      path.join(ROOT, "app/api/cron/appointment-reminders/route.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, " ");
    expect(route).toMatch(/unroutableStudiosWithCandidates/);
    expect(route).not.toMatch(/unroutableStudiosWithCandidates[^;]*onlyStudioIds/);
  });
});
