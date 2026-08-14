import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// 0170, public appointment command, migration source contract.
//
// Byte-level properties of the migration file. Behaviour lives in
// tests/db/public-appointment-command.db.test.ts, which exercises the real
// command against the migrated local database.
// ===========================================================================

const FILE = "supabase/migrations/0170_public_appointment_command.sql";
const SQL = readFileSync(FILE, "utf8");
const FLAT = SQL.replace(/\s+/g, " ");
const CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const PROSE = SQL.split("\n")
  .filter((l) => l.trim().startsWith("--"))
  .join("\n");

const FUNCTIONS = [
  "public_booking_tz_offset_minutes",
  "public_booking_local_to_utc",
  "public_booking_slot_candidates",
  "validate_public_booking_slot",
  "create_public_appointment",
] as const;

const SIGS: Record<string, string> = {
  public_booking_tz_offset_minutes: "(timestamptz, text)",
  public_booking_local_to_utc: "(date, time, text)",
  public_booking_slot_candidates: "(uuid, date, integer)",
  validate_public_booking_slot: "(uuid, uuid, uuid, timestamptz, timestamptz)",
  create_public_appointment: "(uuid, uuid, uuid, timestamptz, text, text, text)",
};

const CREATE_SIG = "(uuid, uuid, uuid, timestamptz, text, text, text)";
const VALIDATE_SIG = "(uuid, uuid, uuid, timestamptz, timestamptz)";

// 0171 superseded 0170 as the repository maximum. Per CLAUDE.md §2, ONLY the
// current maximum migration's own test may assert isRepoMax, an older
// per-migration test that keeps the pin turns every subsequent migration into a
// mechanical sweep, which is exactly how 0163/0164/0165 each went red after
// push. The "nothing above me" tripwire is served centrally by the current
// maximum's test (tests/migrations/0171-public-reschedule-command.test.ts).

describe("0170: declares exactly the two intended functions", () => {
  it("creates only validate_public_booking_slot and create_public_appointment", () => {
    const declared = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual([...FUNCTIONS].sort());
  });

  it("uses create-or-replace so the file is replay-safe", () => {
    for (const fn of FUNCTIONS) {
      expect(SQL).toContain(`create or replace function public.${fn}(`);
    }
    expect(CODE).not.toMatch(/create function public\./);
  });
});

describe("0170: security posture of each function body", () => {
  it("both are SECURITY DEFINER with an empty pinned search_path", () => {
    for (const fn of FUNCTIONS) {
      const body = SQL.slice(SQL.indexOf(`create or replace function public.${fn}(`));
      const head = body.slice(0, body.indexOf("as $$"));
      expect(head, `${fn} must be security definer`).toMatch(/security definer/);
      expect(head, `${fn} must pin an empty search_path`).toMatch(/set search_path = ''/);
    }
  });

  it("never consults current_user or session_user", () => {
    expect(CODE).not.toMatch(/\bcurrent_user\b/);
    expect(CODE).not.toMatch(/\bsession_user\b/);
  });

  it("uses no dynamic SQL", () => {
    expect(CODE).not.toMatch(/execute\s+format/i);
    expect(CODE).not.toMatch(/quote_ident/i);
    expect(CODE).not.toMatch(/jsonb_populate_record/i);
  });

  it("schema-qualifies every table it touches (required by search_path = '')", () => {
    // Checked per KNOWN table name rather than by a generic `from <ident>` scan:
    // plpgsql's `extract(dow from v_local_start)` and the `revoke ... from
    // <role>` statements both match such a scan and are not relation references.
    const TABLES_TOUCHED = [
      "studios",
      "practitioners",
      "service_practitioners",
      "studio_blockouts",
      "studio_availability_overrides",
      "studio_availability_default",
      "studio_calendar_reservations",
      "clients",
      "services",
      "appointments",
      "appointment_audit",
    ];
    for (const t of TABLES_TOUCHED) {
      expect(CODE, `${t} must be referenced`).toContain(`public.${t}`);
      const bare = new RegExp(`\\b(from|join|into)\\s+${t}\\b`, "g");
      expect(CODE.match(bare), `${t} must always be schema-qualified`).toBeNull();
    }
  });
});

describe("0170: the caller cannot request privileged behaviour", () => {
  it("create_public_appointment takes no duration, end time, status or override parameter", () => {
    const sig = SQL.slice(
      SQL.indexOf("create or replace function public.create_public_appointment("),
    ).slice(0, 600);
    for (const forbidden of [
      "p_duration",
      "p_ends_at",
      "p_status",
      "p_practitioner_id",
      "p_allow_outside_availability",
      "p_capacity",
      "p_details",
      "p_audit",
    ]) {
      expect(sig, `must not accept ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("writes status 'confirmed' as a literal", () => {
    expect(FLAT).toContain("v_service_dur, 'confirmed',");
  });

  it("derives duration from the LOCKED service row", () => {
    expect(FLAT).toMatch(
      /select sv\.default_duration_minutes into v_service_dur from public\.services sv where sv\.id = p_service_id and sv\.studio_id = p_studio_id and sv\.active = true for update/,
    );
  });

  it("never sets booked_outside_availability", () => {
    expect(CODE).not.toMatch(/booked_outside_availability\s*(=|,)/);
  });

  it("builds the audit details itself and reads the email from the client row", () => {
    expect(FLAT).toContain("'source', 'public_booking'");
    expect(FLAT).toContain("'email', v_email");
    expect(FLAT).toMatch(/select c\.email into v_email from public\.clients c/);
  });
});

describe("0170: result-code family, not exceptions", () => {
  it("has no 'no_practitioner' refusal: a null practitioner must still book", () => {
    // The pre-0170 route inserted `practitioner_id: owner?.id ?? null` and
    // succeeded. Refusing would silently take public booking down for a studio
    // with no active owner while the page kept offering slots.
    expect(CODE).not.toContain("no_practitioner");
  });

  it("returns closed result codes and never raises", () => {
    expect(CODE).not.toMatch(/raise exception/i);
    for (const code of [
      "studio_not_found",
      "public_booking_unavailable",
      "invalid_time",
      "outside_horizon",
      "invalid_client",
      "invalid_service",
    ]) {
      expect(FLAT, `${code} must be a returnable result`).toContain(`'${code}'::text`);
    }
    // validate_public_booking_slot returns plain `text`, so its codes are not cast.
    for (const code of [
      "invalid_studio",
      "invalid_practitioner",
      "not_eligible",
      "studio_closed",
      "outside_availability",
      "time_unavailable",
      "not_a_public_slot",
    ]) {
      expect(FLAT, `${code} must be a returnable result`).toContain(`return '${code}'`);
    }
  });

  it("does NOT catch 23P01 or the HB001 buffer trigger, they must roll back", () => {
    expect(CODE).not.toContain("23P01");
    expect(CODE).not.toContain("HB001");
    expect(CODE).not.toMatch(/exception\s+when/i);
  });
});

describe("0170: exact public-slot membership", () => {
  it("the validator requires membership in the generated candidate set", () => {
    expect(FLAT).toContain("public.public_booking_slot_candidates(");
    expect(FLAT).toContain("return 'not_a_public_slot'");
  });

  it("takes NO caller-supplied slot-verification escape hatch", () => {
    for (const forbidden of [
      "p_slot_verified",
      "p_is_public_slot",
      "p_allow_arbitrary_start",
      "p_skip_slot_check",
    ]) {
      expect(CODE, `must not accept ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("pins the hourly fallback granularity, not 15 minutes", () => {
    // FALLBACK_GRANULARITY_MINUTES = 60 in lib/booking/slots.ts:115.
    expect(FLAT).toContain("v_m := v_m + 60;");
    expect(PROSE).toMatch(/FALLBACK_GRANULARITY_MINUTES = 60/);
  });

  it("ports local->UTC rather than delegating to AT TIME ZONE for that direction", () => {
    expect(CODE).toContain("public.public_booking_local_to_utc(");
    // The candidate walk must use the ported helper, never the native operator.
    const cands = CODE.slice(CODE.indexOf("public_booking_slot_candidates("));
    const walk = cands.slice(cands.indexOf("while v_m"), cands.indexOf("end loop;"));
    expect(walk).toContain("public.public_booking_local_to_utc");
    expect(walk).not.toMatch(/at time zone/);
  });

  it("generates all three anchor families", () => {
    const cands = CODE.slice(CODE.indexOf("public_booking_slot_candidates("));
    expect(cands, "opening + hourly fallback").toContain("make_time(v_m / 60, v_m % 60, 0)");
    expect(cands, "source-aware protected end").toContain("r.protected_end");
    expect(cands, "backward-packed pre-conflict anchor").toContain(
      "r.starts_at - make_interval(mins => p_duration_minutes + v_buffer)",
    );
  });

  it("keeps the trailing buffer allowed to spill past close", () => {
    const cands = CODE.slice(CODE.indexOf("public_booking_slot_candidates("));
    // The close filter is on the SERVICE end only.
    expect(cands).toContain(
      "c + make_interval(mins => p_duration_minutes) <= v_close_utc",
    );
    expect(cands).not.toContain(
      "c + make_interval(mins => p_duration_minutes + v_buffer) <= v_close_utc",
    );
  });

  it("reads availability studio-wide only, in both the validator and the candidates", () => {
    const scoped = CODE.match(/order by \(.*practitioner_id is not null\) desc/g) ?? [];
    expect(scoped, "no practitioner-scoped precedence anywhere").toEqual([]);
    expect((CODE.match(/practitioner_id is null/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("0170: serialization, owner rule and precision domain", () => {
  it("locks the window's appointment SOURCE rows before deriving candidates", () => {
    // Cancellation/completion/no-show/reschedule lock only their own appointment
    // row and never take the advisory lock, so the candidate set could change
    // between validation and insert. The sources are now locked first.
    expect(FLAT).toMatch(
      /from public\.appointments a where a\.studio_id = p_studio_id[\s\S]{0,220}order by a\.id for update/,
    );
    const cmd = CODE.slice(CODE.indexOf("create or replace function public.create_public_appointment("));
    const lockIdx = cmd.indexOf("order by a.id");
    const validateIdx = cmd.indexOf("public.validate_public_booking_slot(");
    expect(lockIdx, "sources must be locked").toBeGreaterThan(-1);
    expect(lockIdx, "…BEFORE the candidate set is derived").toBeLessThan(validateIdx);
  });

  it("keeps the established lock order: studios -> advisory -> services -> appointments", () => {
    const cmd = CODE.slice(CODE.indexOf("create or replace function public.create_public_appointment("));
    const studios = cmd.indexOf("from public.studios s");
    const advisory = cmd.indexOf("acquire_studio_capacity_lock");
    const services = cmd.indexOf("from public.services sv");
    const appts = cmd.indexOf("from public.appointments a");
    expect(studios).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(studios);
    expect(services).toBeGreaterThan(advisory);
    expect(appts, "appointments last, matching move_or_reassign_appointment").toBeGreaterThan(services);
  });

  it("does NOT lock the whole appointments table", () => {
    expect(CODE).not.toMatch(/lock table/i);
    expect(FLAT).toContain("a.studio_id = p_studio_id");
  });

  it("assigns a practitioner ONLY when there is exactly one active owner", () => {
    // Superseded shape: the count-then-select pair was replaced by a single
    // materialized CTE so the decision comes from ONE snapshot.
    expect(FLAT).toMatch(/with active_owners as materialized/);
    expect(FLAT).toMatch(/when count\(\*\) = 1 then \(array_agg\(id\)\)\[1\] else null end/);
    expect(CODE).not.toMatch(/v_owner_count/);
    expect(CODE).not.toMatch(/order by pr\.created_at/);
  });

  it("normalises every timestamp comparison to the millisecond domain", () => {
    // Not just the final equality, the conflict boundaries too, or the filter
    // runs in a different domain than the candidates.
    // Membership is now an exact equality because sub-millisecond INPUT is
    // rejected up front; the truncating comparison was the thing that let a
    // microsecond-bearing value match a candidate it was not equal to.
    expect(FLAT).toContain("where c = p_starts_at");
    expect(FLAT).not.toContain("where c = date_trunc('milliseconds', p_starts_at)");
    expect(FLAT).toContain("date_trunc('milliseconds', cr.starts_at)");
    expect(FLAT).toContain("date_trunc('milliseconds', r.starts_at)");
    const truncs = (CODE.match(/date_trunc\('milliseconds'/g) ?? []).length;
    expect(truncs, "candidates, overlap filter and validator must all normalise").toBeGreaterThanOrEqual(8);
  });

  it("truncates rather than rounds", () => {
    expect(CODE).not.toMatch(/round\(/i);
    expect(PROSE).toMatch(/truncation, never rounding/i);
  });
});

describe("0170: precision and owner-resolution contracts", () => {
  it("REJECTS sub-millisecond input rather than truncating it", () => {
    // Truncating for the comparison while persisting the raw value split
    // validation and persistence into two precision domains.
    expect(FLAT).toMatch(
      /if p_starts_at is null or p_starts_at is distinct from date_trunc\('milliseconds', p_starts_at\)/,
    );
    expect(FLAT).toMatch(
      /p_starts_at is distinct from date_trunc\('milliseconds', p_starts_at\) or p_ends_at is distinct from date_trunc\('milliseconds', p_ends_at\)/,
    );
  });

  it("establishes ONE authoritative start and uses it end to end", () => {
    expect(FLAT).toContain("v_starts_at := p_starts_at;");
    expect(FLAT).toContain("v_ends_at := v_starts_at + make_interval(mins => v_service_dur)");
    // Derivation, validation, INSERT and RETURN all use the authoritative value.
    expect(FLAT).toContain("v_local_date := (v_starts_at at time zone v_tz)::date");
    expect(FLAT).toContain("p_service_id, v_starts_at, v_ends_at");
    expect(FLAT).toContain("v_starts_at, v_ends_at, v_service_dur, 'confirmed'");
    expect(FLAT).toContain("select 'created'::text, v_appt_id, v_starts_at, v_ends_at");
  });

  it("no raw p_starts_at reaches derivation, the INSERT values list or the return", () => {
    const cmd = CODE.slice(CODE.indexOf("create or replace function public.create_public_appointment("));
    const body = cmd.slice(cmd.indexOf("begin"), cmd.indexOf("$$;"));
    // The only permitted uses are the precision check and the single assignment.
    const uses = (body.match(/\bp_starts_at\b/g) ?? []).length;
    expect(uses, `raw p_starts_at should appear only in the precision guard + assignment, found ${uses}`).toBeLessThanOrEqual(4);
    expect(body).not.toMatch(/p_starts_at \+ make_interval/);
    expect(body).not.toMatch(/p_service_id, p_starts_at, v_ends_at/);
    expect(body).not.toMatch(/p_starts_at, v_ends_at, v_service_dur/);
    expect(body).not.toMatch(/v_appt_id, p_starts_at, v_ends_at/);
  });

  it("membership is an EXACT equality, not a truncating one", () => {
    expect(FLAT).toContain("where c = p_starts_at");
    expect(FLAT).not.toContain("where c = date_trunc('milliseconds', p_starts_at)");
  });

  it("resolves the owner in ONE statement, one snapshot", () => {
    expect(FLAT).toMatch(/with active_owners as materialized/);
    expect(FLAT).toMatch(/when count\(\*\) = 1 then \(array_agg\(id\)\)\[1\] else null end/);
    expect(FLAT).toMatch(/limit 2/);
    // The count-then-select shape must not return.
    expect(CODE).not.toMatch(/v_owner_count/);
    expect(CODE).not.toMatch(/count\(\*\) into v_owner_count/);
    expect(CODE).not.toMatch(/order by pr\.created_at/);
    // The active-owner predicate appears exactly once in the command.
    const cmd = CODE.slice(CODE.indexOf("create or replace function public.create_public_appointment("));
    const body = cmd.slice(0, cmd.indexOf("$$;"));
    expect((body.match(/role = 'owner'/g) ?? []).length).toBe(1);
  });
});

describe("0170: privileges", () => {
  it("revokes EXECUTE from public, anon, authenticated AND service_role by name", () => {
    for (const fn of FUNCTIONS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(SQL).toContain(
          `revoke execute on function public.${fn}${SIGS[fn]} from ${role};`,
        );
      }
    }
  });

  it("grants EXECUTE only to service_role", () => {
    expect(SQL).toContain(
      `grant execute on function public.validate_public_booking_slot${VALIDATE_SIG} to service_role;`,
    );
    expect(SQL).toContain(
      `grant execute on function public.create_public_appointment${CREATE_SIG} to service_role;`,
    );
    for (const fn of FUNCTIONS) {
      expect(SQL).toContain(
        `grant execute on function public.${fn}${SIGS[fn]} to service_role;`,
      );
    }
    const grants = SQL.match(/^grant execute on function/gm) ?? [];
    expect(grants).toHaveLength(5);
    expect(SQL).not.toMatch(/to (anon|authenticated|public)\s*;/);
  });

  it("has exactly twenty revokes: four roles times five functions", () => {
    const revokes = SQL.match(/^revoke execute on function/gm) ?? [];
    expect(revokes).toHaveLength(20);
  });

  it("writes privilege statements literally, never through a DO block", () => {
    expect(CODE).not.toMatch(/do \$\$/);
  });
});

describe("0170: additive scope only", () => {
  it("revokes no table grant and touches no policy, table, trigger or index", () => {
    expect(CODE).not.toMatch(/revoke .* on table/i);
    expect(CODE).not.toMatch(/drop policy/i);
    expect(CODE).not.toMatch(/create policy/i);
    expect(CODE).not.toMatch(/alter policy/i);
    expect(CODE).not.toMatch(/create table/i);
    expect(CODE).not.toMatch(/alter table/i);
    expect(CODE).not.toMatch(/drop table/i);
    expect(CODE).not.toMatch(/create trigger/i);
    expect(CODE).not.toMatch(/drop trigger/i);
    expect(CODE).not.toMatch(/create index/i);
    expect(CODE).not.toMatch(/truncate/i);
  });

  it("backfills nothing and changes no studio flag", () => {
    expect(CODE).not.toMatch(/update public\.studios/i);
    expect(CODE).not.toMatch(/update public\.appointments/i);
    expect(CODE).not.toMatch(/delete from/i);
  });

  it("does not edit any earlier migration's objects", () => {
    // The only functions it defines are its own two; it must not redefine the
    // shared validator or any existing appointment command.
    for (const untouched of [
      "validate_appointment_availability",
      "create_internal_appointment_v2",
      "move_or_reassign_appointment",
      "appointment_buffer_conflict",
    ]) {
      expect(CODE).not.toContain(`create or replace function public.${untouched}`);
    }
  });
});

describe("0170: transaction wrapper", () => {
  it("opens its own transaction with a bounded lock timeout and commits", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^set local lock_timeout = '5s';/m);
    expect(SQL).toMatch(/^commit;/m);
  });
});

describe("0170: prose records the decisions a reviewer must be able to check", () => {
  it("explains why a dedicated public validator exists rather than extending the shared one", () => {
    expect(PROSE).toMatch(/validate_appointment_availability/);
    expect(PROSE).toMatch(/if v_cap then/);
  });

  it("records the parity rules that constrain the implementation", () => {
    expect(PROSE).toMatch(/RE-DERIVES THE OFFER GRID AND REQUIRES EXACT MEMBERSHIP/i);
    expect(PROSE).toMatch(/LOCAL -> UTC IS PORTED/i);
    expect(PROSE).toMatch(/SERVICE END, NOT THE BUFFERED END/i);
  });

  it("no longer claims a truncating comparison stops microsecond smuggling", () => {
    expect(SQL).not.toMatch(/cannot smuggle microseconds past the comparison/i);
    expect(PROSE).toMatch(/sub-millisecond input is REJECTED/i);
  });

  it("describes the practitioner as the SOLE active owner, otherwise null", () => {
    expect(SQL).toMatch(/practitioner \(the SOLE active owner, otherwise null\)/);
    expect(SQL).not.toMatch(/practitioner \(the active owner\)/);
  });

  it("says FIVE function definitions, not two", () => {
    expect(PROSE).toMatch(/five function definitions with no table rewrite/);
    expect(PROSE).not.toMatch(/two function definitions/);
  });

  it("no longer claims the validator never re-derives the grid", () => {
    expect(SQL).not.toMatch(/never re-derives the offer grid/i);
    expect(SQL).toMatch(/RE-DERIVES the current public slot candidate set/);
  });

  it("has no stale two-function language and verifies all FIVE", () => {
    expect(PROSE).not.toMatch(/[Bb]oth functions are new/);
    expect(PROSE).toMatch(/All FIVE functions are new/);
    for (const fn of FUNCTIONS) {
      expect(PROSE, `${fn} must appear in the post-apply verification`).toContain(fn);
    }
    expect(PROSE).toMatch(/EXPECT 15 rows/);
  });

  it("states that this migration does not revoke appointment table grants", () => {
    expect(PROSE).toMatch(/does NOT revoke any table grant/i);
  });

  it("carries the writer census and the migration-max line", () => {
    expect(PROSE).toMatch(/WRITER CENSUS/);
    expect(PROSE).toMatch(/Migration max 0169 -> 0170\./);
  });
});
