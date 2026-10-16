/**
 * MPX-01 — reading validation against a versioned machine profile.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a recorded observation is never
 * destroyed. No clamping, no silent rounding, no unit conversion, no
 * normalisation into a common dose. When a value falls outside a documented
 * range, this returns the value EXACTLY as submitted together with a neutral
 * note saying so. The practitioner saw what the machine showed; a validator
 * that "corrects" her is corrupting a clinical record.
 *
 * WHAT MAY ACTUALLY REFUSE, THEREFORE, IS NARROW:
 *
 *   - structure — an unknown profile, mode, stage or field; a field borrowed
 *     from another mode or another machine; a channel on a machine with none;
 *   - capability — a mode needing an option the studio's device lacks;
 *   - malformed numbers — NaN, Infinity, or a negative duration/current/count,
 *     which is not a bound question but a physically impossible input;
 *   - lineage — a reading captured against a stale contract version;
 *   - a HARDWARE-ENFORCED range, and only one with matching exact-model
 *     evidence and no source disagreement.
 *
 * Everything else is a note. In particular a `published-specification` range
 * and a `recommended-protocol` range NEVER refuse, however emphatic the manual
 * wording: one unit's own documents contradict each other about an intensity
 * limit, and a practitioner reports adjusting her machine beyond its presets.
 * Treating printed guidance as a hardware bound would reject true readings.
 *
 * This module is pure. It performs no I/O, reads no database and enforces no
 * ownership — studio/session ownership and stale-write protection stay with the
 * authoritative block/pass commands, which MPX-02 extends.
 */

import {
  findMode,
  modeFields,
  type MachineField,
  type MachineProfile,
  type NumericRange,
  type ObservationSource,
  type ReadingValue,
} from "./profile-contract";
import { profileById, MACHINE_CATALOGUE } from "./catalogue";

// ---------------------------------------------------------------------------

export type ReadingInput = {
  profileId: string;
  /** The contract version the capture UI was built against. */
  version: number;
  modeKey: string;
  /** Null for a mode-level field; the stage key for a staged reading. */
  stageKey?: string | null;
  fieldKey: string;
  value: ReadingValue;
  source: ObservationSource;
  /** 1-based channel index, only for independently controlled models. */
  channel?: number | null;
};

export type RefusalCode =
  | "unknown_profile"
  | "profile_not_offered"
  | "unknown_mode"
  | "unknown_field"
  | "stale_profile_version"
  | "mode_requires_installed_option"
  | "malformed_value"
  | "channel_not_supported"
  | "channel_out_of_range"
  | "outside_hardware_limit"
  /**
   * MORE DECIMAL PLACES THAN THE CONTRACT DOCUMENTS — a REFUSAL since #860
   * 4289974660, and it was a note until then.
   *
   * The note said "Stored exactly as entered", and that was a promise this
   * system could not keep: 0223's recording command refuses the same value
   * (`scale(v_value) > v_decimals`), so an advisory precision could never
   * reach a row. App and database disagreed, and the app's half was the one
   * making a claim to the practitioner.
   *
   * REFUSING IS THE SIDE THAT SURVIVES SCRUTINY, and the reason is one layer
   * further on than the disagreement. A reading row carries `value_numeric`
   * AND `decimals`, where decimals is the CONTRACT's, never the caller's
   * (`validate-submitted-readings` derives it). Persisting 1.234 against a
   * 2-decimal contract would store a row that disagrees with itself, and any
   * renderer formatting by `decimals` then shows 1.23 — the silent rewrite
   * both sides were written to prevent, reappearing at render time instead of
   * at save. So relaxing the database would not have preserved her reading; it
   * would have hidden a digit later and more quietly.
   *
   * IF THE DOCUMENTED PRECISION IS WRONG, the remedy is the catalogue's own:
   * `unverified: ["decimals"]` exists precisely because an inferred precision
   * is a known hazard, and the fix is an evidence review that republishes the
   * contract — not a row the record cannot render faithfully.
   */
  | "precision_beyond_contract";

export type NoteCode =
  | "outside_published_specification"
  | "recommended_protocol_only"
  | "documentation_discrepancy"
  | "provenance_mismatch"
  | "absence_reason_contradicts_contract"
  | "field_evidence_pending";

export type ValidationNote = { code: NoteCode; message: string };

export type ValidationOutcome =
  | {
      ok: true;
      /** The submitted value, byte-for-byte. Preservation is the contract. */
      recorded: ReadingValue;
      field: MachineField;
      notes: ValidationNote[];
    }
  | { ok: false; code: RefusalCode; message: string };

export type ValidateOptions = {
  /**
   * Options physically installed on the studio's device. A mode gated on an
   * option is refused unless the option is listed here — the profile describes
   * the model, the device records what it actually has.
   */
  installedOptions?: readonly string[];
  /**
   * Allow capture against a non-active profile. Used when re-rendering or
   * re-validating a HISTORICAL reading, which must keep working after its
   * profile is blocked or retired.
   */
  allowNonOffered?: boolean;
  catalogue?: readonly MachineProfile[];
};

// ---------------------------------------------------------------------------

/** Quantities for which a negative number is malformed, not merely unusual. */
const NON_NEGATIVE = new Set(["duration", "current", "count", "percentage", "frequency"]);

function decimalsOf(n: number): number {
  if (Number.isInteger(n)) return 0;
  const s = String(n);
  if (s.includes("e") || s.includes("E")) return Infinity;
  return (s.split(".")[1] ?? "").length;
}

function rangeNote(r: NumericRange, value: number): ValidationNote | null {
  const below = r.min !== undefined && value < r.min;
  const above = r.max !== undefined && value > r.max;
  if (!below && !above) return null;

  const bound = below ? `minimum ${r.min}` : `maximum ${r.max}`;
  if (r.discrepancy) {
    return {
      code: "documentation_discrepancy",
      message: `${value} falls outside the documented ${bound}, and the sources disagree about that bound (${r.discrepancy}). The value is recorded as observed; the disagreement is the finding.`,
    };
  }
  if (r.class === "recommended-protocol") {
    return {
      code: "recommended_protocol_only",
      message: `${value} falls outside a recommended protocol ${bound} (${r.evidence}). Guidance only — recorded as observed.`,
    };
  }
  return {
    code: "outside_published_specification",
    message: `${value} falls outside the published ${bound} (${r.evidence}). Recorded as observed; printed specification wording is not a hardware limit.`,
  };
}

/**
 * Validate one reading against its profile.
 *
 * Returns the submitted value unchanged on success. Callers must store
 * `recorded`, never a value they derived themselves from the input.
 */
export function validateReading(
  input: ReadingInput,
  options: ValidateOptions = {},
): ValidationOutcome {
  const catalogue = options.catalogue ?? MACHINE_CATALOGUE;
  const profile = profileById(input.profileId, catalogue);

  if (!profile) {
    return {
      ok: false,
      code: "unknown_profile",
      message: `No catalogue profile '${input.profileId}'. An unsupported device is never offered as a verified named profile.`,
    };
  }

  // Historical rendering must survive a profile being blocked later, so the
  // offered-ness check is skipped only when the caller says this is not new
  // capture.
  if (!options.allowNonOffered && profile.availability !== "active") {
    return {
      ok: false,
      code: "profile_not_offered",
      message: `Profile '${profile.profileId}' is ${profile.availability}: ${
        profile.availabilityReason ?? "not offered for new capture"
      }`,
    };
  }

  if (input.version !== profile.version) {
    return {
      ok: false,
      code: "stale_profile_version",
      message: `Reading was captured against contract version ${input.version}; the catalogue is at ${profile.version}. Re-read the field contract before writing — a historical reading keeps rendering against the version it was captured under.`,
    };
  }

  const mode = findMode(profile, input.modeKey);
  if (!mode) {
    return {
      ok: false,
      code: "unknown_mode",
      message: `Profile '${profile.profileId}' has no mode '${input.modeKey}'. Modes are per exact model and are never inherited from the family.`,
    };
  }

  if (mode.requiresInstalledOption) {
    const installed = options.installedOptions ?? [];
    if (!installed.includes(mode.requiresInstalledOption)) {
      return {
        ok: false,
        code: "mode_requires_installed_option",
        message: `Mode '${mode.key}' needs the '${mode.requiresInstalledOption}' option, which this device does not report as installed.`,
      };
    }
  }

  // The field must belong to THIS mode at THIS stage. Borrowing a field from a
  // sibling mode or another machine is the cross-reference denial.
  const wantStage = input.stageKey ?? null;
  const entry = modeFields(mode).find(
    ({ field, stageKey }) => field.key === input.fieldKey && stageKey === wantStage,
  );
  if (!entry) {
    return {
      ok: false,
      code: "unknown_field",
      message: `Mode '${mode.key}' of '${profile.profileId}' has no field '${input.fieldKey}'${
        wantStage ? ` in stage '${wantStage}'` : " at mode level"
      }.`,
    };
  }
  const field = entry.field;

  // Channels: only where the model genuinely has independently controlled
  // outputs. A probe-holder outlet is not a channel.
  if (input.channel != null) {
    if (!profile.channels) {
      return {
        ok: false,
        code: "channel_not_supported",
        message: `'${profile.profileId}' has no independently controlled channels. A probe-holder outlet is not a channel.`,
      };
    }
    if (
      !Number.isInteger(input.channel) ||
      input.channel < 1 ||
      input.channel > profile.channels.count
    ) {
      return {
        ok: false,
        code: "channel_out_of_range",
        message: `Channel ${input.channel} is outside 1..${profile.channels.count}.`,
      };
    }
  }

  const notes: ValidationNote[] = [];

  if (
    field.verification === "unverified" ||
    field.verification === "pending-evidence"
  ) {
    notes.push({
      code: "field_evidence_pending",
      message: `Field '${field.key}' is ${field.verification}: ${
        field.note ?? "its label, unit or precision is not yet confirmed against this exact model"
      }`,
    });
  }

  if (field.expectedSource !== input.source) {
    // A note, never a refusal: refusing would discard a real observation over
    // a provenance disagreement. Device-computed status is part of the field's
    // contract, so the mismatch is recorded rather than resolved silently.
    notes.push({
      code: "provenance_mismatch",
      message: `Field '${field.key}' is normally ${field.expectedSource}${
        field.editable ? "" : " and is not editable on the machine"
      }, but this reading is marked ${input.source}.`,
    });
  }

  // --- absence ------------------------------------------------------------
  if (input.value.kind === "absent") {
    if (input.value.reason === "not-applicable") {
      notes.push({
        code: "absence_reason_contradicts_contract",
        message: `Field '${field.key}' is part of mode '${mode.key}', so 'not-applicable' contradicts the contract. Recorded as given; 'not-recorded' is likely meant.`,
      });
    }
    return { ok: true, recorded: input.value, field, notes };
  }

  // --- numbers ------------------------------------------------------------
  const value = input.value.value;

  if (!Number.isFinite(value)) {
    return {
      ok: false,
      code: "malformed_value",
      message: `Field '${field.key}' received a non-finite number.`,
    };
  }
  if (value < 0 && NON_NEGATIVE.has(field.quantity)) {
    return {
      ok: false,
      code: "malformed_value",
      message: `Field '${field.key}' is a ${field.quantity}; ${value} is not a possible observation. This is malformed input, not a documented bound.`,
    };
  }

  // A hardware-enforced, undisputed bound is the only range that refuses.
  for (const r of field.ranges ?? []) {
    if (r.class !== "hardware-enforced" || r.discrepancy) continue;
    const below = r.min !== undefined && value < r.min;
    const above = r.max !== undefined && value > r.max;
    if (below || above) {
      return {
        ok: false,
        code: "outside_hardware_limit",
        message: `Field '${field.key}': the machine cannot be set to ${value} (hardware limit ${
          below ? `min ${r.min}` : `max ${r.max}`
        }, evidence ${r.evidence}).`,
      };
    }
  }

  // Everything else that falls outside a documented range becomes a note.
  for (const r of field.ranges ?? []) {
    if (r.class === "hardware-enforced" && !r.discrepancy) continue;
    const n = rangeNote(r, value);
    if (n) notes.push(n);
  }

  // PRECISION FINER THAN THE CONTRACT IS REFUSED, not noted. See the code's
  // own comment above for why this stopped being advisory: the note promised
  // "Stored exactly as entered" while 0223's command refused the same value,
  // so the promise could never be kept, and persisting it would have produced
  // a row whose value and `decimals` disagree.
  //
  // ROUNDING HERE WOULD STILL BE WRONG, and that half of the original comment
  // stands: this does not round, it refuses and says what it saw. The
  // practitioner reads the machine again, or the contract's precision is
  // wrong and wants an evidence review.
  const given = decimalsOf(value);
  if (given > field.decimals) {
    return {
      ok: false,
      code: "precision_beyond_contract",
      message: `Field '${field.key}' is documented to ${field.decimals} decimal place(s); ${value} carries ${
        given === Infinity ? "exponential" : given
      }. Enter it as the machine displays it — this is not rounded for you, because a precision the record cannot render faithfully is not the reading you took.`,
    };
  }

  return { ok: true, recorded: input.value, field, notes };
}

/**
 * Whether a prior setup may be proposed as carry-forward onto a new target.
 *
 * Carry-forward is a REVIEWABLE PROPOSAL, never an automatic write, and a
 * different device, profile version or mode must not carry incompatible
 * readings across. A changed unit is the clearest case: the same number means a
 * different thing, so it is cleared rather than converted.
 *
 * Note what is deliberately NOT decided here: probe lot may carry forward but
 * its CONFIRMATION never does, and inventory links are rechecked — those rules
 * already live with the existing copy semantics and are untouched by this slice.
 */
export function carryForwardCompatibility(
  from: { profileId: string; version: number; modeKey: string },
  to: { profileId: string; version: number; modeKey: string },
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
):
  | { carry: true }
  | { carry: false; reason: "profile" | "version" | "mode" | "unknown"; message: string } {
  if (from.profileId !== to.profileId) {
    return {
      carry: false,
      reason: "profile",
      message:
        "A different machine. Readings do not transfer between models, and a preset is not interchangeable across them.",
    };
  }
  const profile = profileById(to.profileId, catalogue);
  if (!profile) {
    return { carry: false, reason: "unknown", message: "Unknown target profile." };
  }
  if (from.version !== to.version) {
    return {
      carry: false,
      reason: "version",
      message:
        "The field contract changed between these versions, so labels, units or precision may differ. The prior values stay on their own version untouched.",
    };
  }
  if (from.modeKey !== to.modeKey) {
    return {
      carry: false,
      reason: "mode",
      message:
        "A different mode exposes different fields; carrying the previous mode's readings over would misattribute them.",
    };
  }
  return { carry: true };
}
