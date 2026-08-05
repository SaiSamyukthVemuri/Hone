import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// SOURCE GUARDS — the public reschedule route's authority boundary (0171).
// ===========================================================================
//
// These are textual guards over the route source. They exist because every rule
// below was, at some point, violated by code that typechecked and passed its
// unit tests: a caller-supplied duration, a detached policy INSERT, a
// post-commit re-read that reported failure for a committed reschedule, and a
// "current active owner" lookup standing in for the appointment's practitioner.
//
// A behavioural test proves the command is right. These prove the ROUTE did not
// quietly grow a second authority beside it.

const ROOT = join(__dirname, "..", "..");
const ACTIONS = readFileSync(
  join(ROOT, "app", "reschedule", "[token]", "actions.ts"),
  "utf8",
);
const FORM = readFileSync(
  join(ROOT, "app", "reschedule", "[token]", "RescheduleForm.tsx"),
  "utf8",
);
const MIGRATION = readFileSync(
  join(ROOT, "supabase", "migrations", "0171_public_reschedule_command_v2.sql"),
  "utf8",
);

/** Source with comments stripped, so prose about a pattern never satisfies a guard. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("--"))
    .join("\n");
}

const ACTIONS_CODE = code(ACTIONS);
const MIGRATION_CODE = code(MIGRATION);

describe("public reschedule route — calls v2 and only v2", () => {
  it("calls reschedule_appointment_v2", () => {
    expect(ACTIONS_CODE).toContain('"reschedule_appointment_v2"');
  });

  it("no longer calls the LEGACY reschedule_appointment RPC", () => {
    // `.rpc("reschedule_appointment", ...)` — the exact legacy call shape.
    expect(ACTIONS_CODE).not.toMatch(/rpc\(\s*["']reschedule_appointment["']/);
  });

  it("passes NO end time and NO duration to the command", () => {
    expect(ACTIONS_CODE).not.toContain("p_new_ends_at");
    expect(ACTIONS_CODE).not.toContain("p_new_duration_minutes");
  });

  it("passes the acknowledgement pair the command needs", () => {
    expect(ACTIONS_CODE).toContain("p_acknowledged_policy");
    expect(ACTIONS_CODE).toContain("p_presented_policy_snapshot_hash");
  });
});

describe("public reschedule route — the command owns persistence", () => {
  it("does not INSERT an appointment_policy_acknowledgements row itself", () => {
    expect(ACTIONS_CODE).not.toContain("appointment_policy_acknowledgements");
  });

  it("does not INSERT into appointments or appointment_audit", () => {
    expect(ACTIONS_CODE).not.toMatch(/from\(\s*["']appointments["']\s*\)\s*\.insert/);
    expect(ACTIONS_CODE).not.toContain("appointment_audit");
  });

  it("never re-reads the successor appointment after the command commits", () => {
    // The old code did `.from("appointments").select("*").eq("id", newAppointmentId)`
    // and returned {ok:false} when it failed.
    expect(ACTIONS_CODE).not.toContain("newAppointmentId)");
    expect(ACTIONS_CODE).not.toMatch(/select\(\s*["']\*["']\s*\)[\s\S]{0,80}newAppointmentId/);
  });

  it("builds the successor payload from the parsed command return, not from a re-read", () => {
    expect(ACTIONS_CODE).toContain("starts_at: parsed.startsAt");
    expect(ACTIONS_CODE).toContain("ends_at: parsed.endsAt");
    expect(ACTIONS_CODE).toContain("duration_minutes: parsed.durationMinutes");
    expect(ACTIONS_CODE).toContain("created_at: parsed.createdAt");
  });

  // 0171 amendment. `row.new_appointment_id as string` would silently thread a
  // null into a management URL, an email payload and a notification href.
  // The casts are legitimate in exactly ONE place — inside
  // parseRescheduleSuccessRow, AFTER missingSuccessFields() has validated the
  // row — so the guard is scoped to the ACTION body, which is where an
  // unvalidated cast would actually be dangerous.
  it("the action body never casts a raw command-row field straight to a type", () => {
    const actionBody = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
      ACTIONS_CODE.indexOf("function missingSuccessFields"),
    );
    expect(actionBody).not.toMatch(/row\.new_appointment_id\s+as\s+string/);
    expect(actionBody).not.toMatch(/row\.starts_at\s+as\s+string/);
    expect(actionBody).not.toMatch(/row\.ends_at\s+as\s+string/);
    expect(actionBody).not.toMatch(/row\.duration_minutes\s+as\s+number/);
    expect(actionBody).not.toMatch(/row\.original_starts_at\s+as\s+string/);
    expect(actionBody).not.toMatch(/row\.practitioner_id\s+as\s+string/);
  });

  it("routes every success row through the parser", () => {
    expect(ACTIONS_CODE).toContain("parseRescheduleSuccessRow(row)");
    expect(ACTIONS_CODE).toContain("REQUIRED_SUCCESS_FIELDS");
  });

  it("logs only FIELD NAMES for a malformed success row, never the payload", () => {
    const idx = ACTIONS_CODE.indexOf("public_reschedule_malformed_success_row");
    expect(idx).toBeGreaterThan(-1);
    const window = ACTIONS_CODE.slice(idx, idx + 400);
    expect(window).toContain("missingSuccessFields(row)");
    expect(window).not.toMatch(/JSON\.stringify\(\s*row\s*\)/);
    expect(window).not.toMatch(/\brow\b\s*,/);
  });
});

// ===========================================================================
// 0171 AMENDMENT — the raw successor token must never be lost.
// ===========================================================================
//
// The successor's raw management token is a one-time in-memory secret: only its
// SHA-256 is persisted, the old token is not reused, and nothing can regenerate
// it after the commit. So the confirmation email is the ONLY carrier of the
// credential the client needs to manage the successor.
//
// The command independently re-verifies the client, so a failed application-side
// client lookup does NOT stop the mutation — which is exactly the hazard these
// guards close: commit, skip the email (gated on the client's address), drop the
// token on return.
describe("public reschedule route — token-delivery gate", () => {
  const SUBMIT = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
  );

  it("captures the client lookup's error rather than discarding it", () => {
    expect(SUBMIT).toMatch(/const\s*\{\s*data:\s*clientRow,\s*error:\s*clientErr\s*\}/);
  });

  it("refuses before the mutation on lookup error, missing row OR missing email", () => {
    expect(SUBMIT).toMatch(
      /if\s*\(\s*clientErr\s*\|\|\s*!clientRow\s*\|\|\s*!clientRow\.email/,
    );
  });

  it("scopes the client lookup by studio as well as id (no cross-tenant satisfaction)", () => {
    const idx = SUBMIT.indexOf("clientRow, error: clientErr");
    const window = SUBMIT.slice(idx, idx + 500);
    expect(window).toMatch(/eq\(\s*["']studio_id["']/);
  });

  it("mints the raw token only AFTER the delivery gate", () => {
    const gate = SUBMIT.indexOf("clientErr || !clientRow");
    const mint = SUBMIT.indexOf("generateAppointmentToken()");
    expect(gate).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(gate);
  });

  it("calls the command only AFTER the raw token is minted", () => {
    const mint = SUBMIT.indexOf("generateAppointmentToken()");
    const rpc = SUBMIT.indexOf('"reschedule_appointment_v2"');
    expect(rpc).toBeGreaterThan(mint);
  });

  it("logs no client PII on the refusal path", () => {
    const idx = SUBMIT.indexOf("public_reschedule_client_metadata_unavailable");
    expect(idx).toBeGreaterThan(-1);
    // Exactly the logged object literal — not a fixed character window, which
    // previously swept up the following `const newToken = ...` declaration and
    // failed on a token that is merely DECLARED nearby, not logged.
    const call = SUBMIT.slice(idx, SUBMIT.indexOf("});", idx));
    for (const pii of [
      "clientRow.email",
      "clientRow.name",
      "clientRow.phone",
      "newToken",
      "clientErr.message",
      "clientErr.details",
      "clientErr.hint",
    ]) {
      expect(call, `${pii} must not be logged`).not.toContain(pii);
    }
  });

  it("also captures and gates the studio lookup error", () => {
    expect(SUBMIT).toMatch(/const\s*\{\s*data:\s*studioRow,\s*error:\s*studioErr\s*\}/);
    expect(SUBMIT).toMatch(/if\s*\(\s*studioErr\s*\|\|\s*!studioRow\s*\)/);
  });
});

// SUPERSEDED STRUCTURE, KEPT AS A CONTRACT. The previous amendment wrapped the
// whole post-commit region in ONE try. That contained exceptions correctly but
// CHAINED the effects: a rejected practitioner lookup — an optional enrichment
// used only for a display name — jumped straight to the catch and the client's
// confirmation email was never attempted. The email carries the successor's
// management credential, so the region is now a sequence of INDEPENDENTLY
// isolated effects. These guards assert that shape.
describe("public reschedule route — post-commit exception containment", () => {
  const SUBMIT = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
  );
  const POST_COMMIT_START = SUBMIT.indexOf("parseRescheduleSuccessRow(row)");
  const FINAL_RETURN = SUBMIT.indexOf("return {\n    ok: true,\n    newAppointmentId,");
  const POST_COMMIT = SUBMIT.slice(POST_COMMIT_START, FINAL_RETURN);

  it("has a post-commit region and a committed-success return", () => {
    expect(POST_COMMIT_START).toBeGreaterThan(-1);
    expect(FINAL_RETURN).toBeGreaterThan(POST_COMMIT_START);
  });

  it("every post-commit read and side effect is inside an isolator", () => {
    // Each of these must appear, and each must be reached through `attempt(...)`
    // so its failure degrades ONLY itself.
    for (const op of [
      'from("practitioners")',
      'from("services")',
      "recordPractitionerNotification({",
      "ensureIntakeForClient(",
      "getTreatmentTimeContextForEmail(",
      "sendBookingConfirmationToClient(",
      "recordEmailAttempt(",
      "sendBookingConfirmationSmsToClient(",
    ]) {
      expect(POST_COMMIT.indexOf(op), `${op} must appear post-commit`).toBeGreaterThan(-1);
    }
    // The isolator itself, and no bare shared try wrapping the whole region.
    expect(POST_COMMIT).toContain("await attempt");
  });

  it("the ONLY try/catch in the post-commit region is the isolator's", () => {
    const tries = POST_COMMIT.match(/\btry\s*\{/g) ?? [];
    expect(tries).toHaveLength(1);
    // ...and it lives inside `attempt`, not around the effects.
    const attemptIdx = POST_COMMIT.indexOf("async function attempt<T>");
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(POST_COMMIT.indexOf("try {")).toBeGreaterThan(attemptIdx);
  });

  it("no post-commit SIDE EFFECT can return ok:false", () => {
    // Measured from after the malformed-success-row handling. That ONE branch
    // may return ok:false, and only when the command's return carries no
    // salvageable appointment id — there is then nothing truthful to report.
    // Every other case returns the committed success WITH the management URL.
    const effects = POST_COMMIT.slice(POST_COMMIT.indexOf("const newAppointmentId ="));
    // Match an actual RETURN of a failure, not the string "ok: false" — the
    // confirmation sender's fallback result object legitimately carries
    // `{ ok: false }` because that is the PROVIDER's shape, not the action's.
    expect(effects).not.toMatch(/return\s*\{[^}]*ok:\s*false/);
  });

  it("even a malformed success row still hands back the management URL when it can", () => {
    const malformed = POST_COMMIT.slice(
      POST_COMMIT.indexOf("public_reschedule_malformed_success_row"),
      POST_COMMIT.indexOf("const newAppointmentId ="),
    );
    expect(malformed).toContain("manageUrl");
    expect(malformed).toContain('confirmationEmailStatus: "failed"');
  });

  it("the isolator swallows, logs a SAFE classification, and never rethrows", () => {
    const attemptBody = POST_COMMIT.slice(
      POST_COMMIT.indexOf("async function attempt<T>"),
      POST_COMMIT.indexOf("const created = {"),
    );
    expect(attemptBody).toContain("errorName");
    expect(attemptBody).not.toMatch(/\bthrow\b/);
    for (const leak of ["clientRow", "newToken", "manageUrl", "err.message"]) {
      expect(attemptBody, `${leak} must not be logged`).not.toContain(leak);
    }
  });

  it("the committed-success return is the last statement of the action", () => {
    const tail = SUBMIT.slice(FINAL_RETURN);
    // Only the return object and the closing brace may follow.
    expect(tail).not.toContain("await ");
    expect(tail).not.toContain("ok: false");
  });
});

describe("public reschedule route — practitioner attribution", () => {
  it("resolves the practitioner from the command return", () => {
    expect(ACTIONS_CODE).toContain("row.practitioner_id");
  });

  it('never selects a practitioner by role = "owner"', () => {
    // The old code picked "the current active owner", which is not the
    // appointment's practitioner.
    expect(ACTIONS_CODE).not.toMatch(/eq\(\s*["']role["']\s*,\s*["']owner["']\s*\)/);
  });

  it("scopes the practitioner metadata read by studio as well as id", () => {
    const idx = ACTIONS_CODE.indexOf("assignedPractitionerId");
    expect(idx).toBeGreaterThan(-1);
    const window = ACTIONS_CODE.slice(idx, idx + 900);
    expect(window).toMatch(/eq\(\s*["']studio_id["']/);
  });
});

describe("public reschedule route — no second authority beside the command", () => {
  it("the SUBMIT path does not re-derive an end time in TypeScript", () => {
    // `new Date(start.getTime() + existing.duration_minutes * 60_000)`
    expect(ACTIONS_CODE).not.toMatch(/duration_minutes\s*\*\s*60_?000/);
  });

  it("the SUBMIT path does not run its own horizon check", () => {
    expect(ACTIONS_CODE).not.toContain("isWithinPublicBookingHorizon");
  });

  it("the SUBMIT path does not run its own slot-membership re-check", () => {
    // getAvailableSlots survives ONLY in the two read surfaces. Prove the
    // submit action itself contains no `.some(` membership test.
    const submitIdx = ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction");
    expect(submitIdx).toBeGreaterThan(-1);
    const submitBody = ACTIONS_CODE.slice(submitIdx);
    expect(submitBody).not.toContain("getAvailableSlots");
  });
});

describe("public reschedule route — slot surfaces carry the booked contract", () => {
  it("never uses the service default as the slot duration", () => {
    expect(ACTIONS_CODE).not.toContain("default_duration_minutes ??");
    expect(ACTIONS_CODE).not.toContain("svc?.default_duration_minutes");
  });

  it("passes the original appointment's own reservation as a server-derived exclusion", () => {
    expect(ACTIONS_CODE).toContain("excludeReservation");
    expect(ACTIONS_CODE).toMatch(/sourceKind:\s*["']appointment["']/);
    // The exclusion id comes from the RESOLVED original, never from input.
    expect(ACTIONS_CODE).toContain("sourceId: original.appointment_id");
  });

  it("never reads the exclusion id from form data", () => {
    expect(ACTIONS_CODE).not.toMatch(/formData\.get\(\s*["'][^"']*exclu/i);
    expect(ACTIONS_CODE).not.toMatch(/formData\.get\(\s*["'][^"']*appointment_id/i);
  });

  it("passes the preserved practitioner and the capacity flag to the loader", () => {
    expect(ACTIONS_CODE).toContain("practitionerId");
    expect(ACTIONS_CODE).toContain("practitioner_capacity_enabled");
  });
});

describe("public reschedule — policy hash is server-generated", () => {
  it("the summary carries a server-built presentedPolicyHash", () => {
    expect(ACTIONS_CODE).toContain("presentedPolicyHash");
    expect(ACTIONS_CODE).toContain("buildPolicySnapshot");
  });

  it("the form posts the hash but never policy TEXT", () => {
    expect(code(FORM)).toContain('fd.set("presented_policy_hash"');
    expect(code(FORM)).not.toContain("cancellationPolicyText");
    expect(code(FORM)).not.toContain("noShowPolicyText");
  });

  it("the action never accepts policy text from the form", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /formData\.get\(\s*["'][^"']*policy_text/i,
    );
  });
});

describe("public reschedule — raw token handling", () => {
  it("mints the raw successor token in the action and passes only its hash", () => {
    expect(ACTIONS_CODE).toContain("generateAppointmentToken()");
    expect(ACTIONS_CODE).toContain("hashAppointmentToken(newToken)");
  });

  it("never logs the raw token", () => {
    // Any log line that interpolates newToken directly.
    expect(ACTIONS_CODE).not.toMatch(/logInternal\([^)]*newToken/);
    expect(ACTIONS_CODE).not.toMatch(/console\.(log|error)\([^)]*newToken(?!\`)/);
  });
});

describe("migration 0171 — structural contract", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(MIGRATION_CODE).toMatch(/^begin;/m);
    expect(MIGRATION_CODE).toMatch(/^commit;/m);
    const begin = MIGRATION_CODE.indexOf("begin;");
    const lock = MIGRATION_CODE.indexOf("set local lock_timeout");
    expect(lock).toBeGreaterThan(begin);
  });

  it("creates exactly the three intended functions", () => {
    const created = [
      ...MIGRATION_CODE.matchAll(
        /create or replace function public\.([a-z_0-9]+)\(/g,
      ),
    ].map((m) => m[1]);
    expect(new Set(created)).toEqual(
      new Set([
        "public_reschedule_slot_candidates",
        "validate_public_reschedule_slot",
        "reschedule_appointment_v2",
      ]),
    );
  });

  it("pins search_path = '' and SECURITY DEFINER on every function", () => {
    const defs = MIGRATION_CODE.split("create or replace function").slice(1);
    expect(defs).toHaveLength(3);
    for (const d of defs) {
      expect(d).toContain("security definer");
      expect(d).toContain("set search_path = ''");
    }
  });

  it("revokes from PUBLIC, anon, authenticated AND service_role by name, then grants back only service_role", () => {
    for (const fn of [
      "public_reschedule_slot_candidates",
      "validate_public_reschedule_slot",
      "reschedule_appointment_v2",
    ]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(MIGRATION_CODE).toMatch(
          new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ${role};`),
        );
      }
      expect(MIGRATION_CODE).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`),
      );
    }
  });

  it("grants EXECUTE to nobody except service_role", () => {
    const grants = [...MIGRATION_CODE.matchAll(/grant execute on function[^;]*to ([a-z_]+);/g)].map(
      (m) => m[1],
    );
    expect(grants.length).toBe(3);
    expect(new Set(grants)).toEqual(new Set(["service_role"]));
  });

  it("does NOT drop, re-sign or revoke the legacy reschedule_appointment", () => {
    expect(MIGRATION_CODE).not.toMatch(/drop function[^;]*reschedule_appointment\b/);
    expect(MIGRATION_CODE).not.toMatch(
      /revoke execute on function public\.reschedule_appointment\(/,
    );
    expect(MIGRATION_CODE).not.toMatch(
      /create or replace function public\.reschedule_appointment\(/,
    );
  });

  it("revokes NO table DML — this migration is additive only", () => {
    expect(MIGRATION_CODE).not.toMatch(/revoke\s+(insert|update|delete|all)/i);
    expect(MIGRATION_CODE).not.toMatch(/revoke[^;]*on table/i);
  });

  it("creates or alters no table, policy, trigger or index", () => {
    expect(MIGRATION_CODE).not.toMatch(/create table|alter table|drop table/i);
    expect(MIGRATION_CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(MIGRATION_CODE).not.toMatch(/create trigger|drop trigger/i);
    expect(MIGRATION_CODE).not.toMatch(/create index|create unique index|drop index/i);
  });

  it("does not redefine any existing trigger function", () => {
    // Production's snapshot_appointment_buffer carries an out-of-band GUC
    // bypass that is absent from this repository. A `create or replace` of it
    // from a migration would silently delete that bypass. 0171 must not touch
    // ANY trigger function.
    for (const fn of [
      "snapshot_appointment_buffer",
      "set_appointment_capacity_enabled",
      "bump_appointment_sync_version",
      "sync_appointment_to_calendar_reservation",
      "enqueue_calendar_outbound",
      "enforce_appointment_buffer",
    ]) {
      expect(MIGRATION_CODE).not.toContain(`function public.${fn}(`);
    }
  });

  it("reuses 0170's timezone helpers rather than adding a third DST implementation", () => {
    expect(MIGRATION_CODE).toContain("public.public_booking_local_to_utc");
    expect(MIGRATION_CODE).not.toContain(
      "create or replace function public.public_booking_local_to_utc",
    );
    expect(MIGRATION_CODE).not.toContain(
      "create or replace function public.public_booking_tz_offset_minutes",
    );
  });

  it("schema-qualifies pgcrypto per the repository extension policy", () => {
    expect(MIGRATION_CODE).toContain("extensions.digest(");
    expect(MIGRATION_CODE).toContain("extensions.gen_random_uuid()");
    // A bare digest()/gen_random_uuid() would not resolve under search_path=''.
    expect(MIGRATION_CODE).not.toMatch(/[^.]\bdigest\(/);
    expect(MIGRATION_CODE).not.toMatch(/[^.]\bgen_random_uuid\(/);
  });

  it("reproduces the canonical policy separator exactly, as an E-string", () => {
    // A plain '\n---\n' literal is the four characters backslash-n and would
    // never match buildPolicySnapshot().
    expect(MIGRATION_CODE).toContain("E'\\n---\\n'");
  });

  it("uses a JS-trim-compatible whitespace predicate, never bare btrim()", () => {
    // btrim(x) with no second argument strips ONLY spaces, so it disagrees with
    // String.prototype.trim() on tabs/newlines — and hasAnyPolicy() decides on
    // the page whether the checkbox even renders.
    expect(MIGRATION_CODE).not.toMatch(/btrim\(\s*v_(cancel|noshow)_text\s*\)/);
    expect(MIGRATION_CODE).toContain("[^[:space:]");
    expect(MIGRATION_CODE).toContain("U&'\\FEFF'");
  });

  it("sets cancellation_kind in the SAME statement that cancels the original", () => {
    const upd = MIGRATION_CODE.match(
      /update public\.appointments a\s+set status\s*=\s*'cancelled'[\s\S]*?where a\.id = v_orig\.id;/,
    );
    expect(upd).not.toBeNull();
    expect(upd![0]).toContain("cancellation_kind   = 'rescheduled'");
  });

  it("sets rescheduled_from_appointment_id on the successor INSERT", () => {
    expect(MIGRATION_CODE).toContain("rescheduled_from_appointment_id");
    expect(MIGRATION_CODE).toContain("rescheduled_to_appointment_id = v_new_id");
  });

  it("takes the studio lock and the capacity advisory lock before the appointment locks", () => {
    const forUpdateStudio = MIGRATION_CODE.indexOf("from public.studios s\n   where s.id = v_studio_id\n   for update");
    const advisory = MIGRATION_CODE.indexOf("acquire_studio_capacity_lock(v_studio_id)");
    const apptLock = MIGRATION_CODE.indexOf("order by a.id\n      for update");
    expect(forUpdateStudio).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(forUpdateStudio);
    expect(apptLock).toBeGreaterThan(advisory);
  });

  it("locks the ORIGINAL even when its current start is outside the replacement window", () => {
    expect(MIGRATION_CODE).toContain("a.id = p_original_appointment_id");
  });
});

// ===========================================================================
// 0171 AMENDMENT — the successful result must carry a usable management path,
// and the UI must describe the email truthfully.
// ===========================================================================

describe("public reschedule — the success result carries a management path", () => {
  const SUBMIT = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
  );

  it("the result type declares manageUrl and a CLOSED email-status vocabulary", () => {
    expect(ACTIONS_CODE).toContain("manageUrl: string");
    expect(ACTIONS_CODE).toContain("confirmationEmailStatus: ConfirmationEmailStatus");
    expect(ACTIONS_CODE).toMatch(
      /ConfirmationEmailStatus\s*=\s*"sent"\s*\|\s*"failed"\s*\|\s*"disabled"/,
    );
  });

  it("the committed-success return includes both fields", () => {
    const ret = SUBMIT.slice(SUBMIT.lastIndexOf("return {\n    ok: true,"));
    expect(ret).toContain("manageUrl");
    expect(ret).toContain("confirmationEmailStatus");
  });

  it("resolves the app origin BEFORE the command, and refuses when it cannot", () => {
    const origin = SUBMIT.indexOf("getRequiredAppOrigin()");
    const rpc = SUBMIT.indexOf('"reschedule_appointment_v2"');
    expect(origin).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(origin);
    expect(SUBMIT).toContain("public_reschedule_app_origin_unresolved");
  });

  it("builds the manage URL before the command so success can never lack one", () => {
    const built = SUBMIT.indexOf("const manageUrl =");
    const rpc = SUBMIT.indexOf('"reschedule_appointment_v2"');
    expect(built).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(built);
  });
});

describe("public reschedule — post-commit effects are ISOLATED, not chained", () => {
  const SUBMIT = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
  );

  it("each optional dependency runs through the per-effect isolator", () => {
    // One shared try would let an optional practitioner lookup jump past the
    // client's confirmation email — the carrier of the management credential.
    for (const event of [
      "public_reschedule_practitioner_lookup_failed",
      "public_reschedule_service_lookup_failed",
      "public_reschedule_intake_failed",
      "public_reschedule_treatment_time_failed",
      "public_reschedule_confirmation_email_threw",
      "public_reschedule_email_attempt_write_failed",
      "public_reschedule_sms_failed",
      "public_reschedule_notification_failed",
    ]) {
      expect(SUBMIT, `${event} must be an isolated attempt`).toContain(event);
    }
    expect(SUBMIT).toContain("async function attempt<T>");
  });

  it("the confirmation email is NOT downstream of the optional enrichments", () => {
    // The email call must not sit inside any of their failure paths.
    const email = SUBMIT.indexOf("sendBookingConfirmationToClient({");
    for (const enrichment of [
      "public_reschedule_practitioner_lookup_failed",
      "public_reschedule_service_lookup_failed",
      "public_reschedule_intake_failed",
    ]) {
      expect(SUBMIT.indexOf(enrichment)).toBeLessThan(email);
    }
    expect(email).toBeGreaterThan(-1);
  });

  it("SMS is NOT nested under send_confirmation_emails", () => {
    const emailGate = SUBMIT.indexOf("if (studioRow.send_confirmation_emails)");
    const emailBlockEnd = SUBMIT.indexOf("INDEPENDENT EFFECT B");
    const sms = SUBMIT.indexOf("sendBookingConfirmationSmsToClient({");
    expect(emailGate).toBeGreaterThan(-1);
    expect(sms).toBeGreaterThan(emailBlockEnd);
  });

  it("the email status is derived from the PROVIDER result, never assumed", () => {
    expect(SUBMIT).toMatch(/confirmationEmailStatus\s*=\s*result\.ok\s*\?\s*"sent"\s*:\s*"failed"/);
    expect(SUBMIT).toMatch(/confirmationEmailStatus:\s*ConfirmationEmailStatus\s*=\s*"disabled"/);
  });
});

describe("public reschedule — post-commit logging is classification only", () => {
  const SUBMIT = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction"),
  );

  it("never logs an arbitrary thrown message", () => {
    // A provider or template error can carry the recipient address, a generated
    // management URL (which embeds the RAW successor token) or a credential.
    expect(SUBMIT).not.toMatch(/err\s+instanceof\s+Error\s*\?\s*err\.message/);
    expect(SUBMIT).not.toContain("error: err.message");
    expect(SUBMIT).not.toContain("String(err)");
  });

  it("logs the error NAME instead", () => {
    expect(SUBMIT).toMatch(/errorName:\s*err instanceof Error \? err\.name/);
  });

  it("no logging call references the raw token or a manage URL", () => {
    for (const m of SUBMIT.matchAll(/logInternal\([^;]*?\}\);/gs)) {
      expect(m[0]).not.toContain("newToken");
      expect(m[0]).not.toContain("manageUrl");
      expect(m[0]).not.toContain("cancellationUrl");
      expect(m[0]).not.toContain("rescheduleUrl");
    }
  });
});

describe("public reschedule — the success UI is truthful", () => {
  const FORM_CODE = code(FORM);

  it("never claims a confirmation email is on its way", () => {
    expect(FORM).not.toMatch(/on its way/i);
  });

  it("renders the management link in the success state", () => {
    expect(FORM_CODE).toContain("Manage new appointment");
    expect(FORM_CODE).toContain("href={done.manageUrl}");
  });

  it("stores the management URL and the email status in the success state", () => {
    expect(FORM_CODE).toContain("manageUrl: r.manageUrl");
    expect(FORM_CODE).toContain("emailStatus: r.confirmationEmailStatus");
  });

  it("selects copy from the ACTUAL email status, with all three branches", () => {
    expect(FORM_CODE).toContain('done.emailStatus === "sent"');
    expect(FORM_CODE).toContain('done.emailStatus === "failed"');
    expect(FORM_CODE).toMatch(/a confirmation email has been sent/);
    expect(FORM_CODE).toMatch(/couldn.t send the confirmation email/);
    expect(FORM_CODE).toMatch(/Use the link below to manage your new appointment/);
  });

  it("keeps the client-portal link as a SECONDARY exit", () => {
    const manage = FORM_CODE.indexOf("Manage new appointment");
    const portal = FORM_CODE.indexOf("Back to client portal");
    expect(manage).toBeGreaterThan(-1);
    expect(portal).toBeGreaterThan(manage);
  });
});
