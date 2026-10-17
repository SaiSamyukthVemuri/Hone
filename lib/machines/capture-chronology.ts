import type { RecordedReading } from "@/lib/machines/machine-queries";

/**
 * THE CHRONOLOGY OF ONE TREATMENT'S MACHINE SETTINGS.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS IS FOR, AND IT IS WORTH STATING BLUNTLY
 * ---------------------------------------------------------------------------
 * A recorded capture is PERMANENT AND INVISIBLE. Nothing in the application
 * reads what has already been recorded against the settings block being
 * charted. `setup_capture_history_for_block` exists, is granted to
 * `authenticated`, and is called only by DB tests; `readingsForBlockAction`
 * exists and no component calls it. The only thing a practitioner sees is the
 * entry form's own confirmation - "2 captures saved to this treatment" - which
 * lives in component state and dies on the next page load.
 *
 * So: she records 120 µA, the page reloads, and the chart shows her nothing.
 * She cannot tell whether it saved. Her options are to record it again, which
 * appends a second immutable capture indistinguishable from a genuine
 * mid-treatment change, or to guess.
 *
 * THIS IS NOT COVERED BY THE RETRY KEY. That makes a retry safe WITHIN one
 * mount, where the key is still held. A fresh mount mints a new key, so
 * re-entering the same numbers after a reload is a new save by every measure
 * the database has - correctly, because it cannot know she did not mean it.
 * The only thing that prevents it is showing her what is already there.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not collapse, average, reconcile or interpret. Two groups of one
 * save are genuinely recorded at different instants - she sets one probe, then
 * the next - so nothing here presents them as observed together, which is the
 * rule `latest_setup_for_client` states for the read contract and the reason
 * the Previous treatment panel shows a date and no clock time.
 *
 * It also makes no clinical claim about WHY a setting changed.
 */

/** One capture: a group recorded at one instant, with its own readings. */
export type ChronologyEntry = {
  /**
   * The capture these readings belong to, or null for a reading recorded
   * before captures existed.
   *
   * A NULL IS A REAL CASE, not a gap to be smoothed over, and it must not
   * make every legacy reading collapse into one bucket - see `chronology`.
   */
  captureId: string | null;
  groupKey: string;
  channels: number[];
  revision: number;
  recordedAt: string;
  deviceId: string;
  profileId: string;
  profileVersion: number;
  modeKey: string;
  /** Stable order: field key. */
  readings: RecordedReading[];
};

/**
 * Every capture of one block, oldest first.
 *
 * GROUPED BY CAPTURE, because that is the unit that was actually recorded: a
 * per-field view can pair a current from one capture with a duration from
 * another and show a setup that never existed, which is the defect
 * `latest_setup_for_client` was repaired for.
 *
 * ORDERED BY INSTANT, then by group and revision as a stable tiebreak. Two
 * captures can share a timestamp - the same save's groups often do, to the
 * precision stored - and an unstable order would make the same data render
 * differently on two loads.
 */
export function chronology(
  readings: readonly RecordedReading[],
): ChronologyEntry[] {
  const buckets = new Map<string, ChronologyEntry>();
  for (const r of readings) {
    // A NULL CAPTURE ID IS KEYED BY WHAT IT STILL HAS. Keying every null
    // reading under "null" would merge separate legacy captures into one
    // entry and invent a setup from their union - exactly the per-field
    // composite this grouping exists to prevent.
    const key =
      r.captureId ?? `legacy:${r.groupKey}:${r.revision}:${r.recordedAt}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.readings.push(r);
      continue;
    }
    buckets.set(key, {
      captureId: r.captureId,
      groupKey: r.groupKey,
      channels: r.channels,
      revision: r.revision,
      recordedAt: r.recordedAt,
      deviceId: r.deviceId,
      profileId: r.profileId,
      profileVersion: r.profileVersion,
      modeKey: r.modeKey,
      readings: [r],
    });
  }

  const entries = [...buckets.values()];
  for (const e of entries) {
    e.readings.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
  }
  entries.sort(
    (a, b) =>
      a.recordedAt.localeCompare(b.recordedAt) ||
      a.groupKey.localeCompare(b.groupKey) ||
      a.revision - b.revision,
  );
  return entries;
}

/** One field that was recorded again, with a different value. */
export type SettingChange = {
  groupKey: string;
  fieldKey: string;
  from: RecordedReading;
  to: RecordedReading;
};

const sameValue = (a: RecordedReading, b: RecordedReading): boolean => {
  if (a.value.kind !== b.value.kind) return false;
  if (a.value.kind === "absent" && b.value.kind === "absent") {
    return a.value.reason === b.value.reason;
  }
  if (a.value.kind === "value" && b.value.kind === "value") {
    // THE VALUE ALONE, and nothing about how it is DISPLAYED.
    //
    // `decimals` and `nativeUnit` travel with every reading and are properties
    // of the contract it was recorded under, not of the setting. Two readings
    // of 120 whose declared precision differs are the same setting, so folding
    // either into this comparison would announce an adjustment the
    // practitioner never made.
    //
    // (`value` is already a number by type, so there is no string-versus-number
    // hazard here to guard against - an earlier comment claimed one and a
    // negative control proved the claim untestable.)
    return a.value.value === b.value.value;
  }
  return false;
};

/**
 * The changes within one treatment: a field recorded again at a DIFFERENT
 * value.
 *
 * FOUR THINGS IT REFUSES TO CALL A CHANGE, each of which would be a false
 * statement in a clinical record:
 *
 *   * the same field in a DIFFERENT GROUP. Two probes at different settings
 *     are not one setting that changed;
 *   * the same field recorded again at the SAME value. That is another
 *     capture - she re-read the machine and it still said 120 - and calling
 *     it a change invents an adjustment she did not make;
 *   * a field under a different MODE or a different PROFILE VERSION. The same
 *     field key can mean something else there, so the two numbers are not
 *     comparable at all;
 *   * anything at all when there is only one capture of that field.
 *
 * ADJACENCY IS IN THE OBSERVED SEQUENCE, not in revision arithmetic. If
 * revision 2 is not among the readings handed in, 1 and 3 are adjacent here -
 * which is honest about what is known rather than asserting a step that was
 * never read.
 */
export function changesWithin(
  entries: readonly ChronologyEntry[],
): SettingChange[] {
  // Keyed by everything that has to match for two numbers to be comparable.
  const series = new Map<string, RecordedReading[]>();
  for (const e of entries) {
    for (const r of e.readings) {
      const key = [
        // THE PHYSICAL UNIT FIRST, because a group key is only meaningful
        // within one. Two rooms holding the same model both mint `g1` from a
        // freshly mounted collector, so without this a value read on Room 1
        // and the next on Room 2 paired as one setting's before/after - one
        // probe's adjustment, asserted about two machines, with the change
        // line naming neither (Codex, #860 4294673734).
        //
        // It is the same scoping rule as `groupsFromRecorded`: identity is
        // (device, profile, version, mode) plus the key, never the key alone.
        r.deviceId,
        r.groupKey,
        r.modeKey,
        r.profileId,
        r.profileVersion,
        r.stageKey ?? "",
        r.fieldKey,
      ].join("::");
      const list = series.get(key);
      if (list) list.push(r);
      else series.set(key, [r]);
    }
  }

  const out: SettingChange[] = [];
  for (const list of series.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1]!;
      const to = list[i]!;
      if (sameValue(from, to)) continue;
      out.push({ groupKey: to.groupKey, fieldKey: to.fieldKey, from, to });
    }
  }
  // Oldest change first, matching the chronology it was derived from.
  out.sort(
    (a, b) =>
      a.to.recordedAt.localeCompare(b.to.recordedAt) ||
      a.groupKey.localeCompare(b.groupKey) ||
      a.fieldKey.localeCompare(b.fieldKey),
  );
  return out;
}
