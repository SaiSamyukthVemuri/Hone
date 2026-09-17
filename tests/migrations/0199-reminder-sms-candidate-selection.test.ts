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
  it("creates exactly two functions and nothing else", () => {
    expect((CODE.match(/create or replace function/g) ?? []).length).toBe(2);
    expect(CODE).not.toMatch(/create table|alter table|create index|drop table/i);
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

  it("pins search_path on both functions", () => {
    expect((CODE.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(2);
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
