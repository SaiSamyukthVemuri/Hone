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
 * The instant each item should be SHOWN at: its own, but never earlier than
 * the item it followed in its own series.
 *
 * THE ONE ORDERING RULE for both lists below, so they cannot drift apart
 * (Codex, #860 4308767071). It reconciles two true properties that an earlier
 * fix traded against each other:
 *
 *   * CAPTURES INTERLEAVE. Two groups recorded alternately must render
 *     alternately; ordering by a series' start time grouped each series
 *     together and put a later adjustment before an earlier capture.
 *   * A SERIES IS NEVER BACKWARDS. `recorded_at` is transaction-start
 *     `now()`, so a long transaction starting first and committing second
 *     gives two captures timestamps that invert against their revisions.
 *     Ordering on the raw instant then reported an adjustment the wrong way
 *     round - a clinical record asserting the opposite of what happened.
 *
 * The clamp is a NO-OP wherever nothing is inverted, which is why the result
 * is an honest merge rather than a grouping; where times do invert, the later
 * revision inherits the earlier one's instant so the two TIE, and the caller's
 * revision tiebreak settles them.
 *
 * Keyed by object identity: every item here is a distinct object.
 */
function shownAtWithinSeries<T>(
  items: readonly T[],
  seriesOf: (item: T) => string,
  revisionOf: (item: T) => number,
  timeOf: (item: T) => string,
): Map<T, string> {
  const bySeries = new Map<string, T[]>();
  for (const item of items) {
    const k = seriesOf(item);
    const list = bySeries.get(k);
    if (list) list.push(item);
    else bySeries.set(k, [item]);
  }
  const shown = new Map<T, string>();
  for (const list of bySeries.values()) {
    // REVISION IS THE SEQUENCE WITHIN A SERIES, and it is total: 0223
    // allocates it per capture under a lock. So the clamp runs along the real
    // order, not along the one being corrected.
    const ordered = [...list].sort((a, b) => revisionOf(a) - revisionOf(b));
    let floor: string | null = null;
    for (const item of ordered) {
      const own = timeOf(item);
      const at: string = floor !== null && own < floor ? floor : own;
      shown.set(item, at);
      floor = at;
    }
  }
  return shown;
}

/**
 * Every capture of one block, oldest first.
 *
 * GROUPED BY CAPTURE, because that is the unit that was actually recorded: a
 * per-field view can pair a current from one capture with a duration from
 * another and show a setup that never existed, which is the defect
 * `latest_setup_for_client` was repaired for.
 *
 * ORDERED SO A SERIES READS IN REVISION ORDER, and so the whole list is
 * stable (Codex, #860 4307914915).
 *
 * THE DEFECT. This led on `recordedAt`, which is the TRANSACTION-START
 * `now()` - so a long transaction can start first and commit second, and two
 * captures of the SAME group can carry timestamps that run opposite to their
 * revisions. "Recorded this treatment" then showed capture 2 above capture 1:
 * a chronology asserting an order the record contradicts. Exactly the fault
 * the change series had at 4307735447, on the surface a practitioner actually
 * reads.
 *
 * WHY REVISION CANNOT SIMPLY LEAD. Revisions are allocated PER (block, group,
 * machine, profile, version, mode), so revision 1 of one group and revision 1
 * of another are not comparable - leading on it would interleave unrelated
 * series arbitrarily.
 *
 * SO THE SORT KEY IS (when the SERIES began, the series, the revision). Each
 * series is placed by its own EARLIEST capture, which is a real instant and
 * the one timestamp an inversion cannot move - the first capture of a series
 * is by definition the one with no earlier sibling to swap with. Within a
 * series, revision is authoritative and total. Across series, chronology is
 * preserved to the precision that is actually trustworthy.
 *
 * STILL STABLE, which the previous wording promised and this keeps: two
 * captures sharing a timestamp are separated by series key and then revision,
 * so the same data cannot render two ways on two loads.
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

  // THE SERIES AN ENTRY BELONGS TO. The same scope the revision is allocated
  // in, and the same one `changesWithin` and `groupsFromRecorded` use:
  // identity is (device, profile, version, mode) plus the group key, never the
  // key alone. Two rooms holding one model both mint `g1`.
  const seriesOf = (e: ChronologyEntry) =>
    [e.deviceId, e.profileId, String(e.profileVersion), e.modeKey, e.groupKey].join(
      "::",
    );

  // EACH ENTRY AT ITS OWN INSTANT, CLAMPED WITHIN ITS SERIES (Codex, #860
  // 4308767071).
  //
  // THE DEFECT THIS REPLACES WAS MINE. Round 4 sorted every entry by its
  // SERIES' START time, which groups whole series together: g1 r1 10:00,
  // g2 r1 10:10, g1 r2 10:20 rendered g1:1, g1:2, g2:1 - the 10:20 adjustment
  // before the 10:10 capture. It was fixing a real problem (an inverted
  // transaction-start timestamp reporting an adjustment backwards) with a key
  // that cost a second true property. `shownAtWithinSeries` holds both.
  const shown = shownAtWithinSeries(
    entries,
    seriesOf,
    (e) => e.revision,
    (e) => e.recordedAt,
  );

  entries.sort((a, b) => {
    const ka = seriesOf(a);
    const kb = seriesOf(b);
    return (
      // Interleaved by instant, which is what makes this a MERGE...
      (shown.get(a) ?? a.recordedAt).localeCompare(shown.get(b) ?? b.recordedAt) ||
      // ...across series an equal instant falls through to the series itself,
      // so the order is stable rather than whatever the bucket map yielded...
      ka.localeCompare(kb) ||
      // ...and WITHIN a series this is what settles a clamped tie, which is
      // how an inverted pair stays in revision order. One clause, because for
      // a single series the comparison above is 0 by construction - an extra
      // same-series branch ahead of it could not change an answer, and a
      // clause that cannot change an answer misleads whoever reads it next.
      a.revision - b.revision
    );
  });
  return entries;
}

/** One field that was recorded again, with a different value. */
export type SettingChange = {
  groupKey: string;
  fieldKey: string;
  /**
   * THE COMPONENT THIS SETTING BELONGS TO, or null on an unstaged mode.
   *
   * ON THE CHANGE ITSELF, not left to be read off `to` (Codex, #860
   * 4308488007). It is already part of the series identity below - two stages
   * reusing one field key are never paired - so every reading in a change
   * shares it. Carrying it here is what lets a consumer NAME the component
   * without reaching into one side of the pair and risking the other.
   */
  stageKey: string | null;
  from: RecordedReading;
  to: RecordedReading;
};

const sameValue = (a: RecordedReading, b: RecordedReading): boolean => {
  if (a.value.kind !== b.value.kind) return false;
  if (a.value.kind === "absent" && b.value.kind === "absent") {
    return a.value.reason === b.value.reason;
  }
  if (a.value.kind === "text" && b.value.kind === "text") return a.value.value === b.value.value;
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
    // ORDERED BY REVISION, NOT BY `recordedAt` (Codex, #860 4307735447).
    //
    // THE DEFECT. `recorded_at` is the TRANSACTION-START `now()`, so two
    // captures can carry timestamps that invert against their revisions - a
    // long transaction starting first and committing second. The series
    // inherited its order from `entries`, which sorts on `recordedAt` first,
    // so an inversion SWAPPED a change's from and to: the line then reported
    // 130 -> 120 for an adjustment that went 120 -> 130. A clinical record
    // asserting the opposite of what happened.
    //
    // REVISION IS AUTHORITATIVE HERE and total: every reading in a series
    // shares one identity - device, group, mode, profile, version, stage and
    // field - and 0223 allocates the revision per capture under a lock. So
    // within a series it IS the sequence, and `recordedAt` is left to display.
    //
    // ADJACENCY IS UNCHANGED, which the docblock above promises: this orders
    // the series, it does not interpolate. If revision 2 was not handed in, 1
    // and 3 are still adjacent and still pair - honest about what is known
    // rather than asserting a step nobody read.
    const ordered = [...list].sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1]!;
      const to = ordered[i]!;
      if (sameValue(from, to)) continue;
      out.push({
        groupKey: to.groupKey,
        fieldKey: to.fieldKey,
        stageKey: to.stageKey ?? null,
        from,
        to,
      });
    }
  }
  // Oldest change first, matching the chronology it was derived from - and by
  // the SAME rule, through the same helper (Codex, #860 4308767071).
  //
  // NOT NAMED BY THAT FINDING, and fixed anyway because it is the same defect
  // for the same reason: this list led on `to.recordedAt` with revision as a
  // TIEBREAK, and an inverted transaction-start timestamp is not a tie - so
  // two changes within one series could still be reported in the wrong order,
  // which is a clinical record asserting the opposite of what happened.
  // Fixing the captures and leaving the changes would ship half the property.
  //
  // A CHANGE BELONGS TO ITS `to` READING'S SERIES, which includes the stage:
  // `changesWithin` never pairs across stages, so every change has exactly one.
  const changeSeries = (c: SettingChange) =>
    [
      c.to.deviceId,
      c.to.profileId,
      String(c.to.profileVersion),
      c.to.modeKey,
      c.to.groupKey,
      c.stageKey ?? "",
      c.fieldKey,
    ].join("::");
  const shownChange = shownAtWithinSeries(
    out,
    changeSeries,
    (c) => c.to.revision,
    (c) => c.to.recordedAt,
  );
  out.sort(
    (a, b) =>
      (shownChange.get(a) ?? a.to.recordedAt).localeCompare(
        shownChange.get(b) ?? b.to.recordedAt,
      ) ||
      a.to.revision - b.to.revision ||
      a.groupKey.localeCompare(b.groupKey) ||
      // THE STAGE BEFORE THE FIELD, so the order is TOTAL (Codex, #860
      // 4308488007). Two stages that reuse a field key produce two changes
      // agreeing on every key above this one, and without it their order was
      // whatever the series map happened to yield - an unstable summary on
      // exactly the staged profiles the label fix is for.
      (a.stageKey ?? "").localeCompare(b.stageKey ?? "") ||
      a.fieldKey.localeCompare(b.fieldKey),
  );
  return out;
}
