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
import { profileById, profileAtVersion, MACHINE_CATALOGUE } from "./catalogue";

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
  // A mode the catalogue is not ready to record against, as distinct from a
  // mode the model does not have (Codex, #855 4304921312).
  | "mode_not_offered"
  | "unknown_field"
  | "stale_profile_version"
  // The version exists but has been SUPERSEDED, and this is new capture
  // (Codex, #855 4305019839). Distinct from `stale_profile_version`, which
  // means the catalogue carries no such version at all.
  | "superseded_profile_version"
  | "mode_requires_installed_option"
  | "malformed_value"
  // The contract declares the association mandatory and none was given
  // (Codex, #855 4304921322). Distinct from an out-of-range channel.
  | "channel_required"
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
   * This is NOT new capture: a HISTORICAL reading being re-rendered or
   * re-validated, which must keep working after its profile is blocked or
   * retired.
   *
   * It governs three gates, not one: profile offered-ness, mode offered-ness,
   * and — since Codex #855 4305019839 — whether the reading's contract version
   * must still be the CURRENT one. All three are the same question asked of
   * different fields ("may this be recorded now?"), which is why they share a
   * flag rather than accumulating three.
   */
  allowNonOffered?: boolean;
  catalogue?: readonly MachineProfile[];
};

// ---------------------------------------------------------------------------

/**
 * Quantities for which a negative number is malformed, not merely unusual.
 *
 * `intensity` and `energy-display` JOINED THIS SET to end a disagreement
 * between the layers, not because a new rule was decided (Codex, #860
 * 4301531160). 0223's `record_treatment_setup_submission` already refuses a
 * negative value for all seven quantities as definitional; this set listed
 * only five. So a negative intensity passed `validateReading`, passed the
 * server action, and was refused at PERSISTENCE - she gets a failed save
 * instead of the field telling her, which is the worse of the two places to
 * learn it, and on this path the refusal aborts an atomic create.
 *
 * The SQL rule is the authority here and the application is being brought
 * into line with it; this is not a judgement about what a device can
 * display. Same defect class as the advisory-precision disagreement
 * (4289974660): one contract, two layers, different answers.
 */
const NON_NEGATIVE = new Set([
  "duration",
  "current",
  "count",
  "percentage",
  "frequency",
  "intensity",
  "energy-display",
]);

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
  // THE EXACT VERSION THIS READING WAS CAPTURED UNDER (Codex, #855
  // 4304921305). Resolving by id alone returned whatever version the
  // catalogue currently holds and then refused the reading for not matching
  // it — so a v1 reading became invalid the moment v2 was published, which
  // is the opposite of the guarantee the refusal message states.
  const profile = profileAtVersion(input.profileId, input.version, catalogue);

  if (!profile) {
    // TWO DIFFERENT FACTS, REPORTED DIFFERENTLY. An unknown model is not the
    // same as a model whose contract at that version is not carried.
    const anyVersion = profileById(input.profileId, catalogue);
    if (!anyVersion) {
      return {
        ok: false,
        code: "unknown_profile",
        message: `No catalogue profile '${input.profileId}'. An unsupported device is never offered as a verified named profile.`,
      };
    }
    return {
      ok: false,
      code: "stale_profile_version",
      message: `Reading was captured against contract version ${input.version}; the catalogue carries ${anyVersion.profileId} at version ${anyVersion.version} and no contract for version ${input.version}. A historical reading can only render against the version it was captured under, so that version must stay in the catalogue.`,
    };
  }

  // NEW CAPTURE MUST USE THE CURRENT CONTRACT (Codex, #855 4305019839).
  // Resolving the exact version fixed the historical-rendering defect and
  // opened this one: with v1 and v2 both retained — which is now the whole
  // point of versioned identity — a stale client posting version 1 was
  // validated against v1's labels, precision and ranges and stored as a NEW
  // reading under a superseded contract. `stale_profile_version` could not
  // catch it, since that fires only when the version is ABSENT.
  //
  // `profileById` returns the highest version, and its own documentation
  // already promised "NEW capture resolves through here, so it always gets
  // the current contract" — a promise this function did not keep.
  if (!options.allowNonOffered) {
    const current = profileById(input.profileId, catalogue);
    if (current && current.version !== profile.version) {
      return {
        ok: false,
        code: "superseded_profile_version",
        message: `'${profile.profileId}' contract version ${input.version} has been superseded by version ${current.version}. A new reading records against the current contract — reload before recording. The existing version ${input.version} readings keep rendering against version ${input.version}.`,
      };
    }
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


  const mode = findMode(profile, input.modeKey);
  if (!mode) {
    return {
      ok: false,
      code: "unknown_mode",
      message: `Profile '${profile.profileId}' has no mode '${input.modeKey}'. Modes are per exact model and are never inherited from the family.`,
    };
  }

  // A BLOCKED MODE IS NOT OFFERED, and `activeModes` filtering the picker is
  // not the same thing (Codex, #855 4304921312). Only the PROFILE's
  // availability was checked here, so a caller submitting a blocked mode's
  // key directly — a stale client, a direct action call — was validated
  // against a contract the catalogue says is not ready to record against.
  //
  // THE HISTORICAL PATH IS UNAFFECTED: `allowNonOffered` is exactly the
  // caller saying "this is not new capture", which is why re-rendering a
  // reading whose mode was blocked later still works.
  if (!options.allowNonOffered && mode.availability !== "active") {
    return {
      ok: false,
      code: "mode_not_offered",
      message: `Mode '${mode.key}' of '${profile.profileId}' is ${mode.availability} and is not offered for new capture.`,
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
  // A MANDATORY ASSOCIATION CANNOT BE OMITTED (Codex, #855 4304921322).
  // Every channel check below sits inside `input.channel != null`, so a
  // profile declaring `associationRequired: true` accepted a reading with no
  // channel at all — stored ambiguously, against a contract that says which
  // independently controlled output it belongs to is mandatory. Checked
  // BEFORE the range checks, because the missing case is not a range case.
  if (
    input.channel == null &&
    profile.channels?.associationRequired === true &&
    input.value.kind === "value"
  ) {
    return {
      ok: false,
      code: "channel_required",
      message: `'${profile.profileId}' has independently controlled channels and requires each reading to name one.`,
    };
  }

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

    // A STEP IS PART OF THE SAME CONSTRAINT (Codex, #855 4305243752). `step`
    // is documented as "the smallest increment the machine's control actually
    // moves in", so a value inside the bounds but off the step is just as
    // unreachable as one past the maximum — a 0..10 control with step 2
    // accepted 3. Checking only the endpoints made the step decoration.
    //
    // It refuses under exactly the same conditions as min/max, which is why it
    // sits in this loop rather than its own: hardware-enforced AND undisputed.
    // An advisory range's step stays advisory.
    if (r.step !== undefined && r.step > 0) {
      const base = r.min ?? 0;
      const steps = (value - base) / r.step;
      // A RELATIVE EPSILON, because binary floating point cannot hold a
      // decimal step: 0.3 against step 0.1 gives 2.9999999999999996, and an
      // exact test would refuse a value the machine can obviously reach.
      const drift = Math.abs(steps - Math.round(steps));
      if (drift > 1e-9 * Math.max(1, Math.abs(steps))) {
        return {
          ok: false,
          code: "outside_hardware_limit",
          message: `Field '${field.key}': the machine moves in steps of ${r.step}${
            r.min !== undefined ? ` from ${r.min}` : ""
          }, so it cannot be set to ${value} (evidence ${r.evidence}).`,
        };
      }
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

  // AND THE TARGET MUST BE A CONTRACT THE CATALOGUE ACTUALLY HOLDS (Codex,
  // #855 4304921325). The checks here compared the two INPUTS with each
  // other, so a pair agreeing on a version and mode that do not exist —
  // `version: 99`, `mode: "missing"` — authorised carrying readings forward
  // into a contract nobody has. Agreement between two untrusted inputs is
  // not verification.
  //
  // CHECKED AFTER the comparisons above, deliberately: a genuine version
  // or mode CHANGE has its own, more useful explanation, and it would be a
  // worse answer to tell her the target is not current when what actually
  // happened is that the contract moved. The tampered case has from and to
  // AGREEING on a version nobody has, so it falls through to here.
  if (to.version !== profile.version) {
    return {
      carry: false,
      reason: "version",
      message:
        "The target is not the current field contract for this model, so carrying values into it would attribute them to a contract that is not in use.",
    };
  }
  if (!findMode(profile, to.modeKey)) {
    return {
      carry: false,
      reason: "mode",
      message:
        "The target mode does not exist on this model. Modes are per exact model and are never inherited from the family.",
    };
  }

  return { carry: true };
}
