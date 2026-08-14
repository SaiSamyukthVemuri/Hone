"use server";

import { revalidatePath } from "next/cache";
import { mapSessionCommandError } from "@/lib/sessions/session-command-errors";
import { mapBlockCommandError } from "@/lib/sessions/block-command-errors";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { validateProbeLotId } from "@/lib/sessions/probe-lot-validation";
import { normalizeChips, verifyStoredChips } from "@/lib/observation-chips";
import type { ElectrolysisMode } from "@/lib/types/database";
import {
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  PULSE_DELAY_RANGE_ERROR,
} from "@/lib/constants";

const VALID_MODES: ReadonlyArray<ElectrolysisMode> = ["thermo", "galv", "blend"];

// Pulse delay is recorded only when multiple pulses were done (pulse_count >
// 1); a single-pulse entry stores null. When applicable the value must be in
// [0.03, 1.90], an out-of-range value throws the same clean message the UI
// shows. Rounded to 2 decimal places.
function resolvePulseDelay(
  value: FormDataEntryValue | null,
  pulseCount: number,
): number | null {
  if (pulseCount <= 1) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < PULSE_DELAY_MIN || n > PULSE_DELAY_MAX) {
    throw new Error(PULSE_DELAY_RANGE_ERROR);
  }
  return Math.round(n * 100) / 100;
}

function clampedPulseCount(value: FormDataEntryValue | null): number {
  if (typeof value !== "string" || value.trim() === "") return PULSE_COUNT_DEFAULT;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return PULSE_COUNT_DEFAULT;
  return Math.min(PULSE_COUNT_MAX, Math.max(PULSE_COUNT_MIN, n));
}

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function nullableNumber(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Non-negative numeric (fractional ok). Out-of-range / invalid → null, matching
// the lenient pickInteger pattern. Used for galvanic_ma, units_of_lye, and
// thermolysis_duration_seconds (all sub-integer readings, e.g. PicoBlend 0.733s).
function nonNegNumber(value: FormDataEntryValue | null): number | null {
  const n = nullableNumber(value);
  return n != null && n >= 0 ? n : null;
}

// Parses a JSON array of strings from form data and returns trimmed,
// deduplicated, non-empty entries. Falls back to [] for any malformed input.
function parseAreasJson(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function assertSessionVisible(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load session: ${error.message}`);
  if (!data) throw new Error("Session not found.");
}

// Migration 0019/0020 plumbing: every electrolysis entry should point at a
// session block. After the 0020 backfill, all pre-existing sessions have a
// "Main" block. For sessions created entirely after 0019 (no entries yet), the
// first block is created on demand from the entry's own treatment params.
//
// L18 Phase 2: this helper NO LONGER READS OR WRITES the database. Finding the
// primary block (and creating it when the session has none) now happens
// inside `add_electrolysis_pass` (migration 0166), in the same transaction as
// the entry and under a row lock. Two defects go with the move: the block and
// the entry can no longer commit separately (a failed entry write used to leave
// an orphan block behind), and the read-then-insert race that could produce two
// "Main" blocks for concurrent first entries is gone. All this builds is the
// value bag the command uses when it does have to create that first block.
type EnsureBlockParams = {
  sessionId: string;
  mode: ElectrolysisMode | null;
  apilusModality: string | null;
  energyLevel: number | null;
  minutesPerformed: number | null;
  probeType: string | null;
  probeSize: string | null;
  machineFrequency: string | null;
};

function defaultBlockValues(params: EnsureBlockParams): Record<string, unknown> {
  return {
    block_name: "Main",
    mode: params.mode,
    apilus_modality: params.apilusModality,
    energy_level: params.energyLevel,
    minutes_performed: params.minutesPerformed,
    probe_type: params.probeType,
    probe_size: params.probeSize,
    machine_frequency: params.machineFrequency,
  };
}

// Chip-loading fix: the write action reports a DISCRIMINATED outcome so the form
// can tell the three states apart and NEVER blind-retry a write that may already
// have persisted:
//   * ok         : verified: the row was created AND a SEPARATE read-back of the
//                   stored observation_chips matched what was submitted.
//   * invalid    , nothing was inserted; the submitted chips were unreadable
//                   (malformed JSON) or not an array. Safe to fix + resubmit.
//   * not_persisted, the insert itself failed; no row exists. Safe to retry.
//   * unverified : a row WAS created (entryId returned) but the stored chips
//                   could not be confirmed. NOT atomic: the row is not rolled
//                   back (no transaction/RPC in scope), so the caller must NOT
//                   silently resubmit; it surfaces a recovery message + reload.
export type AddElectrolysisEntryResult =
  | { ok: true; entryId: string; observationChips: string[] }
  | { ok: false; code: "invalid_input"; error: string }
  | { ok: false; code: "not_persisted"; error: string }
  | { ok: false; code: "unverified"; entryId: string; error: string };

const CHIPS_UNREADABLE_ERROR =
  "Your observations couldn't be read, so nothing was saved. Please re-select them and try again.";
const CHIPS_UNVERIFIED_ERROR =
  "This pass may have been saved, but we couldn't confirm your observations recorded correctly. Don't re-add it: reload the session to check first.";

// Strict parse of the submitted observation_chips form field.
//   * Absent / blank string  → no chips selected (valid; normalizes to []).
//   * Valid JSON array       → canonicalized + deduped via normalizeChips.
//   * Present, non-empty, but NOT parseable JSON → invalid (fail before insert).
//   * Parses to a non-array (object/string/number/boolean/null) → invalid.
// Never coerces malformed/non-array input to [], that would silently discard the
// practitioner's selections and then "verify" the empty value as success.
function parseSubmittedChips(
  raw: FormDataEntryValue | null,
): { ok: true; chips: string[] } | { ok: false } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: true, chips: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  return { ok: true, chips: normalizeChips(parsed) };
}

// L18 Phase 2: the block/entry atomicity exception that used to sit here is
// RETIRED. This action is still block-coupled, when the submitted form omits
// `block_id` (a legacy caller shape it deliberately still supports) the primary
// block has to be found or created, but both halves now happen inside
// `add_electrolysis_pass` (migration 0166), in one transaction. A failed entry
// write can no longer leave an orphan block behind.
export async function addElectrolysisEntryAction(
  formData: FormData,
): Promise<AddElectrolysisEntryResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const areas = parseAreasJson(formData.get("areas"));

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  if (areas.length === 0) throw new Error("Area is required.");
  // The legacy `area` column is still NOT NULL in the schema. Migration 0017
  // adds `areas text[]`, but the column stays around for backwards compat
  // until a follow-up migration drops it. Mirror the first array value.
  const area = areas[0];

  // Chip-loading fix: parse the STRUCTURED observation chips FIRST, before any
  // studio lookup / session read / insert. A malformed or non-array payload
  // fails the whole action here, nothing is inserted, no verification query
  // runs, and we never silently coerce lost selections to [] and then "verify"
  // that empty value as success (the exact silent-loss path this incident is
  // about). Absent/blank/empty-array all normalize to [] and proceed.
  const chipParse = parseSubmittedChips(formData.get("observation_chips"));
  if (!chipParse.ok) {
    return { ok: false, code: "invalid_input", error: CHIPS_UNREADABLE_ERROR };
  }
  const observationChips = chipParse.chips;

  const modeRaw = formData.get("mode");
  const mode =
    typeof modeRaw === "string" && VALID_MODES.includes(modeRaw as ElectrolysisMode)
      ? (modeRaw as ElectrolysisMode)
      : null;

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  // Migration 0011: Apilus parameters are now per-entry. Galvanic carries
  // no apilus_modality or energy_level even if the form happens to submit one.
  const apilusModalityRaw = pickEnum(
    formData.get("apilus_modality"),
    APILUS_MODALITY_VALUES,
  );
  const apilusModality = mode === "galv" ? null : apilusModalityRaw;
  const energyLevelRaw = pickInteger(formData.get("energy_level"), {
    min: 0,
  });
  const energyLevel = mode === "galv" ? null : energyLevelRaw;
  const minutesPerformed = pickInteger(formData.get("minutes_performed"), {
    min: 0,
  });
  const probeType = pickEnum(formData.get("probe_type"), PROBE_TYPE_VALUES);
  const machineFrequency = pickEnum(
    formData.get("machine_frequency"),
    MACHINE_FREQUENCY_VALUES,
  );
  const hairsTreated = pickInteger(formData.get("hairs_treated"), { min: 0 });
  const probeSize = nullableString(formData.get("probe_size"));

  // Migration 0042: structured blend / galvanic readings, mode-gated so a
  // thermolysis entry never carries galvanic numbers (and vice versa).
  // Out-of-range values are coerced to null (lenient, like the other
  // numeric fields); the DB CHECK is the final guard.
  const wantGalv = mode === "galv" || mode === "blend";
  const wantThermo = mode === "thermo" || mode === "blend";
  const galvanicMa = wantGalv ? nonNegNumber(formData.get("galvanic_ma")) : null;
  const galvanicDurationSeconds = wantGalv
    ? pickInteger(formData.get("galvanic_duration_seconds"), { min: 0 })
    : null;
  // galvanic_intensity_percent is a RETIRED reading: the "add another pass" form
  // no longer sends it and this action deliberately does NOT read it, so a forged
  // form field can never land. New rows always store NULL (see the insert below).
  const thermolysisIntensityPercent = wantThermo
    ? pickInteger(formData.get("thermolysis_intensity_percent"), {
        min: 0,
        max: 100,
      })
    : null;
  // Thermolysis duration is fractional (e.g. PicoBlend 0.733s), parse as a
  // decimal, NOT pickInteger, or 0.733 would silently truncate to 0. Matches the
  // block form's write path and the numeric DB column.
  const thermolysisDurationSeconds = wantThermo
    ? nonNegNumber(formData.get("thermolysis_duration_seconds"))
    : null;
  const unitsOfLye = wantGalv ? nonNegNumber(formData.get("units_of_lye")) : null;

  // The simplified entry form passes block_id explicitly so multi-block
  // sessions target the correct block. Legacy form callers omit this; for
  // them we look up (or create) the primary block via ensureBlockForSession.
  const explicitBlockId = nullableString(formData.get("block_id"));
  // When absent, the command finds-or-creates the primary block itself; these
  // are only the values it uses if it has to create one.
  const blockDefaults = defaultBlockValues({
    sessionId,
    mode,
    apilusModality,
    energyLevel,
    minutesPerformed,
    probeType,
    probeSize,
    machineFrequency,
  });

  const pulseCount = clampedPulseCount(formData.get("pulse_count"));
  const pulseDelaySeconds = resolvePulseDelay(
    formData.get("pulse_delay_seconds"),
    pulseCount,
  );

  const supabase = await createClient();
  // PR 3: never trust a client-supplied probe_lot_id. It must be a well-formed
  // UUID that belongs to THIS studio's probe_lots inventory; otherwise reject.
  // (An absent/free-text lot is fine: probe_lot_number is a separate manual
  // field and is not made "inventory-verified" here.)
  const lotCheck = await validateProbeLotId(
    supabase,
    studio.id,
    nullableString(formData.get("probe_lot_id")),
  );
  if (!lotCheck.ok) throw new Error(lotCheck.error);
  // L18 Phase 2: block resolution + the entry write are ONE transaction via
  // add_electrolysis_pass (migration 0166). The returned entry id comes from
  // the command's own RETURNING, not a post-commit re-read, so the chip
  // verification below is still a genuinely SEPARATE read.
  const { data: passRows, error } = await supabase.rpc("add_electrolysis_pass", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_block_id: explicitBlockId,
    p_block_defaults: blockDefaults,
    p_area: area,
    p_areas_list: areas,
    p_probe_size: probeSize,
    p_probe_lot_id: lotCheck.value,
    p_mode: mode,
    p_intensity: nullableNumber(formData.get("intensity")),
    p_duration_seconds: nullableNumber(formData.get("duration_seconds")),
    p_pulse_count: pulseCount,
    p_pulse_delay_seconds: pulseDelaySeconds,
    p_comments: nullableString(formData.get("comments")),
    p_observation_chips: observationChips,
    p_apilus_modality: apilusModality,
    p_energy_level: energyLevel,
    p_minutes_performed: minutesPerformed,
    p_probe_type: probeType,
    p_machine_frequency: machineFrequency,
    p_hairs_treated: hairsTreated,
    p_galvanic_ma: galvanicMa,
    p_galvanic_duration_seconds: galvanicDurationSeconds,
    // galvanic_intensity_percent is RETIRED: the command takes no parameter for
    // it, so a new row always stores NULL: enforced by the database, not here.
    p_thermolysis_intensity_percent: thermolysisIntensityPercent,
    p_thermolysis_duration_seconds: thermolysisDurationSeconds,
    p_units_of_lye: unitsOfLye,
  });

  const inserted = Array.isArray(passRows)
    ? (passRows[0] as { entry_id?: string } | undefined)
    : (passRows as { entry_id?: string } | null);
  if (error || !inserted?.entry_id) {
    // The command raises before writing anything, and rolls back the block with
    // the entry, so a failure here means NO row exists. Safe for the caller to
    // retry, and the message is mapped, never the raw database text.
    return {
      ok: false,
      code: "not_persisted",
      error: error
        ? `Failed to add entry: ${mapBlockCommandError(error)}`
        : "Failed to add entry: the entry did not persist",
    };
  }
  const entryId = inserted.entry_id;


  // PERSISTED-ROW VERIFICATION (structural guard against the silent partial-write
  // defect class behind this incident: an insert can "succeed" yet the clinical
  // field never land). This is a SEPARATE read of the row we just created, by its
  // exact id and scoped to the session (already confirmed to belong to this
  // studio via assertSessionVisible; RLS enforces the studio boundary), then a
  // STRICT check of the raw stored array (raw duplicates / non-canonical / non-array
  // all fail, never masked by dedup).
  const { data: verifyRow, error: verifyErr } = await supabase
    .from("electrolysis_entries")
    .select("observation_chips")
    .eq("id", entryId)
    .eq("session_id", sessionId)
    .maybeSingle();

  // NOTE ON ATOMICITY: the insert has already committed. There is no transaction
  // or RPC in this emergency scope to roll it back, so a verification failure is a
  // PERSISTED-but-UNVERIFIED state, not a clean pre-insert failure. We return the
  // created entryId and a recovery message; we do NOT delete the row and do NOT
  // report success. The caller must block a blind resubmit (which would create a
  // duplicate clinical entry) and route the practitioner to reload/inspect.
  if (verifyErr || !verifyRow) {
    return { ok: false, code: "unverified", entryId, error: CHIPS_UNVERIFIED_ERROR };
  }
  const verdict = verifyStoredChips(
    (verifyRow as { observation_chips: unknown }).observation_chips,
    observationChips,
  );
  if (!verdict.ok) {
    return { ok: false, code: "unverified", entryId, error: CHIPS_UNVERIFIED_ERROR };
  }

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  // Verified: return the created id + the confirmed stored value.
  return { ok: true, entryId, observationChips };
}

export async function addLaserEntryAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const zone = nullableString(formData.get("zone"));

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  if (!zone) throw new Error("Zone is required.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const equipmentParams: Record<string, string> = {};
  const fluence = nullableString(formData.get("fluence"));
  const pulseWidth = nullableString(formData.get("pulse_width"));
  const spotSize = nullableString(formData.get("spot_size"));
  if (fluence) equipmentParams.fluence = fluence;
  if (pulseWidth) equipmentParams.pulse_width = pulseWidth;
  if (spotSize) equipmentParams.spot_size = spotSize;

  const sessionNumberRaw = formData.get("session_number");
  const sessionNumber =
    typeof sessionNumberRaw === "string" && sessionNumberRaw.trim() !== ""
      ? parseInt(sessionNumberRaw, 10)
      : null;

  const supabase = await createClient();
  // L18 Phase 1A: written through the narrow reviewed command
  // `create_laser_entry` (migration 0164) rather than a direct table INSERT.
  // The command is SECURITY DEFINER with a pinned empty search_path; it
  // requires a non-null auth.uid(), resolves the studio and client from the
  // trusted `sessions` row, requires the caller to be an ACTIVE practitioner of
  // that studio, and re-checks the asserted client. This action writes ONLY
  // laser_entries (it has no session_blocks dependency) which is why it is
  // the one writer this phase could move atomically. The thrown message shape
  // is unchanged.
  const { error } = await supabase.rpc("create_laser_entry", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_zone: zone,
    p_session_number: Number.isFinite(sessionNumber) ? sessionNumber : null,
    p_equipment_params:
      Object.keys(equipmentParams).length > 0 ? equipmentParams : null,
    p_observation_notes: nullableString(formData.get("observation_notes")),
  });

  if (error) throw new Error(`Failed to add entry: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

// Migration 0114: a treatment PASS (an electrolysis_entries / laser_entries row)
// is removed by an AUDITED SOFT-DELETE, deleted_at/deleted_by/delete_reason,
// NEVER a hard delete. The clinical record is preserved (and still visible in
// audit/history) but hidden from every active view. This mirrors the
// session_blocks soft-delete pattern (softDeleteSessionBlockAction, 0019). Only
// the selected pass is voided; the block/area, session, appointment, client,
// other passes, and photos are untouched.
async function softDeleteEntry(
  table: "electrolysis_entries" | "laser_entries",
  formData: FormData,
): Promise<void> {
  const id = formData.get("id");
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const rawReason = formData.get("reason");
  if (typeof id !== "string" || !id) throw new Error("Missing entry id.");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  // Reason is optional but captured for the audit trail when provided.
  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    throw new Error("Inactive practitioners cannot remove passes.");
  }
  // Verifies the session belongs to THIS studio + client (rejects cross-studio).
  await assertSessionVisible(studio.id, clientId, sessionId);

  // L18 FINAL (migration 0169) revoked INSERT/UPDATE/DELETE from `authenticated`
  // on both pass tables; only SELECT remains. The soft-delete UPDATE therefore
  // has to run as service_role, the authenticated client now fails it with
  // 42501, which is exactly the production regression this restores.
  //
  // Service_role BYPASSES RLS, so RLS no longer contributes anything to tenant
  // isolation on this write. Everything above is therefore load-bearing, and the
  // filter below re-states the whole lineage chain rather than leaning on it:
  //
  //   * the actor is a server-resolved ACTIVE practitioner of `studio`
  //     (getCurrentPractitionerWithStudio -> session cookie -> auth.getUser());
  //     the browser cannot supply a practitioner or studio id.
  //   * assertSessionVisible has already proved `sessionId` names a session in
  //     BOTH that studio and the route's client, read through the AUTHENTICATED
  //     client so the caller's own visibility still gates it.
  //   * `.eq("id", id)` is the primary key, so at most one row can ever match.
  //   * `.eq("session_id", sessionId)` pins the row to that proved session.
  //     session_id is NOT NULL and FK-constrained, so an entry belonging to
  //     another session (and therefore to another client or studio) cannot
  //     match. Neither pass table carries its own studio_id/client_id; the
  //     session IS the lineage, which is why this predicate is the boundary.
  //   * `.is("deleted_at", null)` keeps it to a single ACTIVE pass, rejecting a
  //     double-void instead of restamping an already-removed row.
  //
  // The sibling pass in the same area, the block, the session, the appointment,
  // the client and the photos are all untouched: nothing but this one entry id
  // is addressed, and the write is an UPDATE of the three soft-delete columns.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from(table)
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
      delete_reason: reason,
    })
    .eq("id", id)
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    // Never surface the raw database message to the practitioner: with the
    // service-role client it can name tables, columns and privilege state. Log
    // the sqlstate + non-clinical ids for operators and return fixed copy.
    console.error(
      JSON.stringify({
        event: "remove_pass_update_failed",
        table,
        code: error.code,
        studioId: studio.id,
        sessionId,
        entryId: id,
        timestamp: new Date().toISOString(),
      }),
    );
    throw new Error("Could not remove this pass. Please try again.");
  }
  // Exactly one active pass must have changed. Zero means it was already removed
  // (or never belonged to this session), a SAFE failure, never a silent success.
  // More than one is impossible against a primary key, so it is treated as a
  // hard fault rather than assumed benign.
  if (!data || data.length !== 1) {
    if (data && data.length > 1) {
      console.error(
        JSON.stringify({
          event: "remove_pass_multi_row",
          table,
          matched: data.length,
          studioId: studio.id,
          sessionId,
          entryId: id,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new Error("Could not remove this pass. Please try again.");
    }
    throw new Error("This pass has already been removed.");
  }
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteElectrolysisEntryAction(
  formData: FormData,
): Promise<void> {
  await softDeleteEntry("electrolysis_entries", formData);
}

export async function deleteLaserEntryAction(formData: FormData): Promise<void> {
  await softDeleteEntry("laser_entries", formData);
}

export async function updateSessionPriceAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const rawDollars = formData.get("price_dollars");
  let priceCents: number | null;
  if (typeof rawDollars !== "string" || rawDollars.trim() === "") {
    priceCents = null;
  } else {
    const n = Number(rawDollars);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("Price must be a non-negative number.");
    priceCents = Math.round(n * 100);
  }

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_session_price", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_price_cents: priceCents,
  });
  if (error) throw new Error(`Failed to update price: ${mapSessionCommandError(error)}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

// PR #190 (clinical memory, migration 0082). Saves the plan for the
// client's NEXT visit, written while charting this one. Optional;
// empty input clears the note. Surfaced as "From last visit" context
// on the next charting screen and in the previous-session panels.
// PR #191: returns a result instead of throwing so the form can show
// explicit saved / error feedback (Chloe could not tell whether her
// note saved).
export type NextSessionNoteResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: string };

export async function updateNextSessionNoteAction(
  formData: FormData,
): Promise<NextSessionNoteResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client." };
  }

  const note = nullableString(formData.get("next_session_note"));

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_next_session_note", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_note: note,
  });
  if (error) {
    return { ok: false, error: "Could not save the note. Try again." };
  }
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, cleared: note === null };
}

export async function updateSessionPerformerAction(
  formData: FormData,
): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const performerId = formData.get("performer_id");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  // Confirm the chosen practitioner belongs to this studio (RLS already
  // restricts visibility, but a second check guards against tampering).
  const newPerformerId = typeof performerId === "string" && performerId
    ? performerId
    : null;

  // The same-studio check on the chosen practitioner now happens INSIDE the
  // command, in the same transaction as the write, so a practitioner cannot be
  // moved out of the studio between the check and the update.
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_session_performer", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_performer_id: newPerformerId,
  });
  if (error) throw new Error(`Failed to update performer: ${mapSessionCommandError(error)}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export type EditStartedAtResult =
  | { ok: true }
  | { ok: false; error: string };

const APILUS_MODALITY_VALUES = [
  "Multiplex",
  "Microflash",
  "Picoflash",
  "Synchro",
  "Thermoflash",
  "Meloflash",
  "Evolublend",
  "Omniblend",
  "Picoblend",
  "Synchroblend",
  "Multiblend",
] as const;
const PROBE_TYPE_VALUES = [
  "Stainless steel regular",
  "Stainless steel gold",
  "IBL",
  "ITH",
] as const;
const MACHINE_FREQUENCY_VALUES = ["13.56 MHz", "27.12 MHz"] as const;

function pickEnum<T extends string>(
  raw: FormDataEntryValue | null,
  allowed: ReadonlyArray<T>,
): T | null {
  if (typeof raw !== "string" || raw === "") return null;
  return (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : null;
}

function pickInteger(
  raw: FormDataEntryValue | null,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

export async function editSessionStartedAtAction(
  formData: FormData,
): Promise<EditStartedAtResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const newStartedAtRaw = formData.get("new_started_at");

  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }
  if (typeof newStartedAtRaw !== "string" || !newStartedAtRaw) {
    return { ok: false, error: "Pick a date and time." };
  }

  const newDate = new Date(newStartedAtRaw);
  if (Number.isNaN(newDate.getTime())) {
    return { ok: false, error: "That isn't a valid date or time." };
  }
  if (newDate.getTime() > Date.now()) {
    return { ok: false, error: "Session time cannot be in the future." };
  }
  const newStartedAtIso = newDate.toISOString();

  // The studio is no longer needed here: the command derives it from the
  // session itself. The active check stays so the practitioner sees the exact
  // same message without a round trip.
  const { practitioner } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit sessions." };
  }

  // L18 Phase 3: the read-validate-write-audit sequence is now ONE transaction
  // via edit_session_started_at (migration 0167). Previously the update
  // committed first and the session_audit insert followed with only a console
  // log on failure, so a corrected time could exist with no audit trail.
  const supabase = await createClient();
  const { error } = await supabase.rpc("edit_session_started_at", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_started_at: newStartedAtIso,
  });
  if (error) {
    return { ok: false, error: mapSessionCommandError(error) };
  }

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");

  return { ok: true };
}

export async function softDeleteSessionAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const reasonRaw = formData.get("delete_reason");

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length < 10) {
    throw new Error("Reason must be at least 10 characters.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    throw new Error("Inactive practitioners cannot delete sessions.");
  }
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  // deleted_by is derived by the command from auth.uid(), never sent.
  const { error } = await supabase.rpc("soft_delete_session", {
    p_session_id: sessionId,
    p_client_id: clientId,
    p_reason: reason,
  });
  if (error) throw new Error(`Failed to delete session: ${mapSessionCommandError(error)}`);

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}`);
}
