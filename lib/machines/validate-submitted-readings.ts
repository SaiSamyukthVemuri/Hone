import { validateReading } from "@/lib/machines/validate-reading";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";
import { OBSERVATION_SOURCES } from "@/lib/machines/machine-queries";
import type {
  ReadingInputRow,
  ReadingSubmission,
} from "@/lib/machines/machine-queries";

// MPX-03 — ONE DEFINITION of what a submitted reading has to satisfy.
//
// WHY IT LIVES IN lib/ RATHER THAN BESIDE ONE ACTION. Three server paths now
// record machine settings: the per-group command, the whole-save command, and
// the INITIAL save that creates the treatment area and records its settings in
// one transaction. The third lives in `block-actions.ts`, a different module
// from the other two, and a validator reachable from only one of them is a
// rule that holds on some paths and not others.
//
// IT WAS A LOCAL FUNCTION IN machine-setup-actions.ts UNTIL THE CREATE PATH
// NEEDED IT, and the type checker is what found that: `InitialSetupInput`
// required `nativeUnit` and `decimals` on every reading - precisely the two
// fields `ReadingSubmission` omits on purpose, because they are MACHINE facts
// the server derives from the published contract and must never accept from a
// caller (Codex, 9c6fbbe5). The create path would also have skipped
// `stale_profile_version`, which the DATABASE cannot catch: the command
// validates against the unit's own registered version, so a reading derived
// under a newer catalogue version would be recorded under the older one and
// permanently mislabelled.

/**
 * Record one settings group against a treatment block.
 *
 * No studio is sent: the block determines it in the database, and a block in
 * another studio is refused there. The machine is required, and the readings
 * are validated against the server's own catalogue before the write, so a
 * field the model does not have never reaches the table.
 */

/**
 * Validate one group's readings against the DEVICE's registered contract, and
 * return the rows to store.
 *
 * SHARED BY BOTH RECORDING ACTIONS, and that is the whole reason it is a
 * function. The whole-save action validates several groups; doing it inline
 * would have been a second copy of this loop, and a second copy of a clinical
 * validation rule is a second place for it to drift. The same mistake has been
 * made and corrected three times in this feature already.
 *
 * EVERY CHECK HERE COMES FROM `lib/machines/validate-reading.ts` rather than
 * being re-derived. An earlier version of this code derived the descriptor
 * from `nativeFieldGroups` and checked only that the field EXISTS, which was a
 * partial reimplementation of a validator already written for exactly this and
 * checking more than it did:
 *
 *   * malformed_value - a negative current or duration. The database has no
 *     equivalent constraint, so without this an impossible value becomes an
 *     IMMUTABLE clinical row through the ordinary UI;
 *   * stale_profile_version - the device is registered against a contract
 *     version, and the version passed below is the DEVICE's, not the
 *     catalogue's. A direct action call bypasses selectableDevices, so without
 *     this the action could derive version-N units while the RPC stamps the
 *     row with the device's older version: a permanently mislabelled reading;
 *   * unknown_field / unknown_mode / channel bounds /
 *     mode_requires_installed_option, against the options the device actually
 *     has.
 *
 * Both gaps found by Codex at a66f5ec9. The lesson is the same one twice:
 * reach for the validator that exists rather than re-deriving a weaker version
 * of it at the call site.
 */
export function validateSubmittedReadings(
  device: StudioDevice,
  profile: MachineProfile,
  modeKey: string,
  readings: readonly ReadingSubmission[],
  /**
   * The channels THE GROUP named, which may be empty.
   *
   * REQUIRED, not defaulted (Codex, #860 4309004312). Without it every
   * reading reached `validateReading` with no channel, so a contract
   * declaring `associationRequired: true` refused even a group that HAD named
   * one - and the channel-range checks never ran on this path at all. A
   * defaulted `[]` would have let any of the three callers silently keep that,
   * which is the same trap the required `inFlight` on `canEditDraft` exists
   * for.
   */
  channels: readonly number[],
): { rows: ReadingInputRow[] } | { error: string } {
  const rows: ReadingInputRow[] = [];
  for (const r of readings) {
    if (!OBSERVATION_SOURCES.includes(r.observationSource)) {
      return { error: "That is not a recognised way of observing a reading." };
    }
    const reading = (channel: number | null) => ({
      profileId: profile.profileId,
      // The DEVICE's registered version, so a stale registration is refused
      // here rather than silently captured under today's contract.
      version: device.profileVersion,
      modeKey,
      stageKey: r.stageKey,
      fieldKey: r.fieldKey,
      value: r.value,
      source: r.observationSource,
      ...(channel === null ? {} : { channel }),
    });
    const options = {
      installedOptions: device.installedOptions,
      catalogue: catalogueForRuntime(),
    };
    // EVERY CHANNEL THE GROUP NAMED, and a single UNASSOCIATED pass when it
    // named none - which is what lets `channel_required` fire where the
    // contract requires an association and stay silent where it does not.
    //
    // NO SENTINEL ARRAY. The first spelling built `[null]` for the empty case
    // and then indexed it with a non-null assertion; a negative control that
    // emptied that array turned out to be a NO-OP, because the resulting
    // `channel: undefined` reads as absent to the validator exactly as `null`
    // does. So the mutation could not be caught - not because a test was
    // missing, but because the shape made two different intents
    // indistinguishable. This says the thing directly instead.
    const first: number | null = channels.length > 0 ? channels[0]! : null;
    const checked = validateReading(reading(first), options);
    if (!checked.ok) return { error: checked.message };
    // THE REST ARE CHECKED FOR THEMSELVES, not for their field: the resolved
    // field is the same whichever channel is named, but an out-of-range or
    // malformed channel further down the list must still be refused rather
    // than stored.
    for (const channel of channels.slice(1)) {
      const also = validateReading(reading(channel), options);
      if (!also.ok) return { error: also.message };
    }
    rows.push({
      stageKey: r.stageKey,
      fieldKey: r.fieldKey,
      // The machine's own unit and precision, off the field the VALIDATOR
      // resolved. Never the caller's opinion of them.
      nativeUnit: checked.field.unit ?? "none",
      decimals: checked.field.decimals,
      observationSource: r.observationSource,
      value: checked.recorded,
    });
  }
  return { rows };
}
