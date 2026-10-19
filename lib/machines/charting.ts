/**
 * MPX-03 — the native field projection, setting groups and next-visit payoff.
 *
 * WHAT THIS LAYER IS FOR. Once a machine is selected, the chart must show only
 * that model's applicable fields, under the machine's own labels and units, in
 * the machine's own grouping — and next visit it must give the setup back
 * accurately enough to reproduce or adjust. New capture without an accurate
 * retrieval payoff is incomplete, so both halves live here together.
 *
 * THREE RULES CARRIED FROM THE CONTRACT
 *
 * 1. A HISTORICAL RENDERER USES THE RECORDED VERSION. When a stored setup's
 *    contract version is not the current one, this resolves its retained exact
 *    version for labels and units, falling back to keys if unavailable. Relabelling old
 *    numbers with new units is how a record quietly starts lying.
 *
 * 2. ADVISORY IS NOT BLOCKING. `blocksSubmission` is true only for an actual
 *    refusal. A published-specification range, a source disagreement, a
 *    precision note and a pending-evidence note all travel to the UI as
 *    advisory text and never stop a practitioner recording what she saw.
 *
 * 3. CARRY-FORWARD IS A PROPOSAL. It is never written for her, and it clears
 *    on a device, mode or contract-version change rather than converting
 *    anything. Clearing a proposal never touches the stored prior setup.
 *
 * WHAT THIS FILE DOES NOT DECIDE. Outcomes and minutes performed are not
 * settings; single-pulse and galvanic clearing rules, probe lot carrying
 * forward while its CONFIRMATION never does, and the recheck of active
 * inventory links all remain with the existing copy semantics, untouched by
 * this slice.
 */

import {
  findMode,
  modeFields,
  type MachineField,
  type MachineMode,
  type MachineProfile,
  type NativeUnit,
  type ReadingValue,
} from "./profile-contract";
import { MACHINE_CATALOGUE, profileById, profileAtVersion } from "./catalogue";
import {
  carryForwardCompatibility,
  type ValidationOutcome,
} from "./validate-reading";

// ---------------------------------------------------------------------------
// Native field projection
// ---------------------------------------------------------------------------

/**
 * The units that are WRITTEN AS NOTHING, in one place.
 *
 * `device-display` and `none` are sentinels, not units: the machine's own label
 * already carries the meaning, and inventing a unit for a 5HD's UE or an ST
 * 350's UL would be the exact normalisation the contract forbids. Printing the
 * sentinel itself is worse than printing nothing - "1.25 device-display" reads
 * as a unit the machine has and does not.
 */
const UNWRITTEN_UNITS: ReadonlySet<string> = new Set(["device-display", "none"]);

/** How a unit is written next to an input, from TODAY'S contract. */
export function unitLabel(unit: NativeUnit): string {
  return UNWRITTEN_UNITS.has(unit) ? "" : unit;
}

/**
 * The same rule for a unit read back off the RECORD.
 *
 * SEPARATE FROM `unitLabel` BECAUSE THE INPUT IS DIFFERENT, not because the
 * rule is. `treatment_setup_readings.native_unit` is a free text column holding
 * whatever the contract said when the row was written, so it is a `string` and
 * may be a unit today's `NativeUnit` union no longer contains. Anything that is
 * not a sentinel is therefore printed VERBATIM - a historical µA stays µA, and
 * harmonising it to today's vocabulary is the one thing this must never do.
 *
 * It exists because the recorded-history surface printed the sentinels
 * literally while the entry form beside it did not: the same reading rendered
 * "1.25" with an input and "1.25 device-display" in the history below
 * (Codex, #860 4288424526).
 */
export function recordedUnitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNWRITTEN_UNITS.has(unit) ? "" : unit;
}

/**
 * How a recorded reading was obtained, in words, for the clinical record.
 *
 * THE PROVENANCE WAS STORED AND NEVER SHOWN (Codex, #860 4301669064). The
 * write path records `observation_source`, the SQL emits it and the query
 * preserves it, but neither the recorded-history row nor the
 * previous-treatment renderer consumed it - so an ESTIMATED value and a
 * value transcribed off the machine's own display rendered identically on
 * the chart. Those are different clinical facts about the same number.
 *
 * RENDERED FOR EVERY SOURCE, NOT ONLY A MISMATCH, and that is deliberate.
 * Showing it only when it disagrees with the expectation would mean reading
 * the expectation off TODAY'S contract, which is exactly what the finding
 * says not to do: a contract may be republished at a new version, and a
 * historical row's provenance must not change meaning because the model's
 * current description did. The stored value is the only thing that is
 * still true about how that reading was obtained.
 *
 * Null for a row written before the column existed; those render nothing
 * rather than being backfilled with a guess.
 */
export function observationSourceLabel(
  source: string | null | undefined,
): string {
  switch (source) {
    case "machine-displayed":
      return "from the machine display";
    case "device-computed":
      return "computed by the machine";
    case "practitioner-entered":
      return "entered by hand";
    case "estimated":
      return "estimated";
    default:
      // An unknown value is NOT invented into a label. A row from before the
      // column existed, or one carrying a source this build does not know,
      // says nothing rather than something wrong.
      return "";
  }
}

export type FieldDescriptor = {
  key: string;
  stageKey: string | null;
  /**
   * WHO THE CONTRACT SAYS OBSERVED THIS, carried so the entry surface can
   * submit it instead of claiming every value was typed from scratch.
   *
   * It was absent here, so the UI labelled EVERY reading
   * "practitioner-entered" - including fields the contract marks as
   * machine-displayed or device-computed. The RPC accepts and permanently
   * stores that, so activating any such profile would have produced
   * incorrect provenance even when the practitioner transcribed the display
   * accurately (Codex, 15cc6c99).
   */
  expectedSource: MachineField["expectedSource"];
  label: string;
  unit: string;
  decimals: number;
  optional: boolean;
  editable: boolean;
  /** Shown as help text. Never a validation failure. */
  advisory: string[];
};

export type FieldGroup = {
  key: string;
  /** The machine's name for this grouping. */
  label: string;
  fields: FieldDescriptor[];
};

function describe(field: MachineField, stageKey: string | null): FieldDescriptor {
  const advisory: string[] = [];
  if (field.note) advisory.push(field.note);
  if (field.verification === "pending-evidence" || field.verification === "unverified") {
    advisory.push(
      "This field's label, unit or precision is not yet confirmed against this exact model.",
    );
  }
  for (const r of field.ranges ?? []) {
    if (r.class === "hardware-enforced" && !r.discrepancy) continue;
    const span = [
      r.min !== undefined ? `min ${r.min}` : null,
      r.max !== undefined ? `max ${r.max}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    advisory.push(
      r.discrepancy
        ? `Documented ${span}, but sources disagree (${r.discrepancy}). Record what the machine shows.`
        : `${r.class === "recommended-protocol" ? "Recommended" : "Published"} ${span}. Guidance only.`,
    );
  }
  return {
    key: field.key,
    stageKey,
    expectedSource: field.expectedSource,
    label: field.nativeLabel,
    unit: unitLabel(field.unit),
    decimals: field.decimals,
    optional: field.optional,
    editable: field.editable,
    advisory,
  };
}

/**
 * The fields to render for one mode, in the machine's own grouping.
 *
 * Mode-level readings come first, then one group per stage in declared order —
 * which is how MultiPlex's slow-thermolysis and snap components stay visibly
 * separate, and how the existing blend-group ordering is preserved rather than
 * flattened into one list.
 */
export function nativeFieldGroups(
  profile: MachineProfile,
  mode: MachineMode,
): FieldGroup[] {
  const groups: FieldGroup[] = [];
  if (mode.fields.length > 0) {
    groups.push({
      key: "_mode",
      label: mode.nativeLabel,
      fields: mode.fields.map((f) => describe(f, null)),
    });
  }
  for (const stage of mode.stages) {
    groups.push({
      key: stage.key,
      label: stage.nativeLabel,
      fields: stage.fields.map((f) => describe(f, stage.key)),
    });
  }
  return groups;
}

/** True only for a genuine refusal. Advisory notes never reach this. */
export function blocksSubmission(outcome: ValidationOutcome): boolean {
  return outcome.ok === false;
}

// ---------------------------------------------------------------------------
// Setting groups — one shared setup, or several when probes differ
// ---------------------------------------------------------------------------

/**
 * One set of readings that applies to one or more probes.
 *
 * `channels` is OPTIONAL association, confirmed by the workflow when it
 * matters. The practitioner ruling is explicit: a GEMM setup saves without
 * sixteen mandatory rows, and no rotating-probe position, status indicator or
 * per-channel row is required. Where probes genuinely differ, a second group
 * preserves that difference instead of one value being falsely labelled a
 * global control.
 */
export type SettingGroup = {
  groupId: string;
  channels: number[];
  readings: Record<string, ReadingValue>;
};

/**
 * The starting shape of a chart: exactly ONE group, with no channel
 * association, however many channels the machine has.
 *
 * This is the whole "no 16 mandatory rows" rule, expressed where it cannot be
 * forgotten.
 */
export function defaultSettingGroups(): SettingGroup[] {
  return [{ groupId: "g1", channels: [], readings: {} }];
}

/** Add a group, for when one probe is set differently from the rest. */
export function addSettingGroup(groups: readonly SettingGroup[]): SettingGroup[] {
  return [
    ...groups,
    { groupId: `g${groups.length + 1}`, channels: [], readings: {} },
  ];
}

export type GroupIssue = { groupId: string; problem: string };

/**
 * Structural problems in a set of groups. Deliberately NOT "you must fill in
 * every channel": the only real errors are a channel the machine does not have
 * and the same channel claimed twice.
 */
export function settingGroupIssues(
  profile: MachineProfile,
  groups: readonly SettingGroup[],
): GroupIssue[] {
  const out: GroupIssue[] = [];
  const seen = new Map<number, string>();
  for (const g of groups) {
    if (g.channels.length > 0 && !profile.channels) {
      out.push({
        groupId: g.groupId,
        problem: `${profile.model} has no independently controlled channels.`,
      });
      continue;
    }
    for (const c of g.channels) {
      if (profile.channels && (c < 1 || c > profile.channels.count)) {
        out.push({
          groupId: g.groupId,
          problem: `Channel ${c} is outside 1..${profile.channels.count}.`,
        });
      }
      const already = seen.get(c);
      if (already && already !== g.groupId) {
        out.push({
          groupId: g.groupId,
          problem: `Channel ${c} is already recorded in ${already}.`,
        });
      }
      seen.set(c, g.groupId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Next visit: retrieval and the carry-forward proposal
// ---------------------------------------------------------------------------

/** A setup as it was stored. Immutable input everywhere below. */
export type RecordedSetup = {
  profileId: string;
  profileVersion: number;
  modeKey: string;
  groups: SettingGroup[];
  recordedAt: string;
  sessionId: string;
};

export type PriorSetupRow = {
  key: string;
  /** The exact recorded contract's label, when that version is retained. */
  label: string;
  unit: string;
  /** Rendered value, or the reasoned absence. */
  display: string;
};

export type PriorSetupView = {
  machine: string;
  profileId: string;
  profileVersion: number;
  modeLabel: string;
  groups: Array<{ groupId: string; channels: number[]; rows: PriorSetupRow[] }>;
  recordedAt: string;
  sessionId: string;
  /**
   * True when the stored version is not the catalogue's current one. The rows
   * resolve the retained recorded version or fall back to keys; never today's labels.
   */
  renderedAgainstHistoricalVersion: boolean;
};

function displayValue(v: ReadingValue, decimals: number): string {
  if (v.kind === "absent") {
    return v.reason === "not-applicable"
      ? "—"
      : v.reason === "not-legible"
        ? "not legible"
        : "not recorded";
  }
  // Pad to the contract's precision for display only. The stored number is
  // never altered, and a value finer than the contract keeps its own digits.
  const own = String(v.value).split(".")[1]?.length ?? 0;
  return v.value.toFixed(Math.max(decimals, own));
}

/**
 * The next-visit payload: what machine, what mode, every recorded group and
 * channel, with units and the source session and time.
 */
export function priorSetupView(
  setup: RecordedSetup,
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): PriorSetupView | { unavailable: string } {
  const profile = profileById(setup.profileId, catalogue);
  if (!profile) {
    return {
      unavailable: `This setup was recorded on profile '${setup.profileId}', which is no longer in the catalogue. The readings are preserved as recorded.`,
    };
  }

  const historical = setup.profileVersion !== profile.version;
  const recorded = profileAtVersion(setup.profileId, setup.profileVersion, catalogue);
  const mode = recorded ? findMode(recorded, setup.modeKey) : undefined;
  const byKey = new Map<string, MachineField>();
  if (mode) {
    for (const { field } of modeFields(mode)) byKey.set(field.key, field);
  }

  return {
    machine: `${profile.manufacturer} ${profile.model}${
      profile.variant ? ` (${profile.variant})` : ""
    }`,
    profileId: profile.profileId,
    profileVersion: setup.profileVersion,
    modeLabel: mode?.nativeLabel ?? setup.modeKey,
    recordedAt: setup.recordedAt,
    sessionId: setup.sessionId,
    renderedAgainstHistoricalVersion: historical,
    groups: setup.groups.map((g) => ({
      groupId: g.groupId,
      channels: [...g.channels],
      rows: Object.entries(g.readings).map(([key, value]) => {
        const field = byKey.get(key);
        return {
          key,
          // No field means either a historical version or a retired field: show
          // the recorded key rather than inventing a label for it.
          label: field?.nativeLabel ?? key,
          unit: field ? unitLabel(field.unit) : "",
          display: displayValue(value, field?.decimals ?? 0),
        };
      }),
    })),
  };
}

export type SetupProposal =
  | { propose: true; groups: SettingGroup[]; needsReview: true }
  | { propose: false; reason: "profile" | "version" | "mode" | "unknown"; message: string };

/**
 * Propose the prior setup for a new pass, or clear it with a reason.
 *
 * Always `needsReview`: a carried setup is a starting point the practitioner
 * confirms, never an automatic write. The returned groups are deep copies, so
 * editing the proposal cannot reach the stored prior setup.
 */
export function proposeSetup(
  prior: RecordedSetup,
  target: { profileId: string; profileVersion: number; modeKey: string },
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): SetupProposal {
  const compat = carryForwardCompatibility(
    {
      profileId: prior.profileId,
      version: prior.profileVersion,
      modeKey: prior.modeKey,
    },
    {
      profileId: target.profileId,
      version: target.profileVersion,
      modeKey: target.modeKey,
    },
    catalogue,
  );
  if (!compat.carry) {
    return { propose: false, reason: compat.reason, message: compat.message };
  }
  return {
    propose: true,
    needsReview: true,
    groups: prior.groups.map((g) => ({
      groupId: g.groupId,
      channels: [...g.channels],
      readings: { ...g.readings },
    })),
  };
}
