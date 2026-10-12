/**
 * MPX-03 — machine-first selection, remembered per practitioner and studio.
 *
 * THE WORKFLOW RULING THIS IMPLEMENTS: the practitioner picks the physical
 * studio machine and its exact profile BEFORE entering any setting, and that
 * choice persists for her within that studio across new charts, navigation and
 * refresh until she explicitly changes it. Choices stay isolated between users
 * and between studios. A device that becomes unavailable is shown as
 * unavailable and a valid replacement is required — never silently swapped.
 *
 * WHY RESOLUTION TAKES NO CLIENT OR SESSION. `resolveSelection` is a function
 * of (scope, devices) alone. That is not an omission, it is the mechanism: a
 * remembered choice that cannot see which chart is open cannot be reset by
 * opening a new one, so "survives a new chart" holds by construction rather
 * than by a test passing today. The same argument covers reload — resolution
 * reads the store every time and keeps no instance state.
 *
 * NO MIGRATION IN THIS SLICE. `SelectionStore` is a port. The storage PR backs
 * it with a sticky column on `public.practitioners`, following the precedent
 * already in the schema: 0084 added `default_machine_frequency` as a last-used
 * UI default and 0178 made it writable through
 * `set_own_default_machine_frequency(p_studio_id, …)`, which resolves
 * `own_practitioner_in_studio` and returns NULL for a non-member. That table is
 * `unique (studio_id, user_id)` with `studio_id not null`, so a column there IS
 * per-practitioner-per-studio — the isolation this module requires needs no
 * extra keying, and `selectionKey` encodes the same pair so the eventual column
 * cannot be keyed more loosely than the logic.
 *
 * A number was deliberately NOT reserved: a census across every worktree and
 * open PR shows 0211–0218 already claimed by other lanes, and the contiguity
 * guard means a higher number only goes green stacked on all of them.
 *
 * THE SELECTION IS A UI DEFAULT, NOT THE CLINICAL RECORD. Exactly as with the
 * sticky frequency: what was actually used is recorded on the block/pass. A
 * practitioner changing her remembered machine must never alter a stored
 * reading.
 */

import {
  activeModes,
  type MachineMode,
  type MachineProfile,
} from "./profile-contract";
import { MACHINE_CATALOGUE, profileById } from "./catalogue";

// ---------------------------------------------------------------------------

/** Who the remembered choice belongs to. Both halves are load-bearing. */
export type SelectionScope = {
  studioId: string;
  practitionerId: string;
};

/**
 * The storage key. One practitioner in one studio.
 *
 * Asserted in tests so the storage PR cannot key the column by practitioner
 * alone: the same person working in two studios keeps two separate machines,
 * and `practitioners` already gives one row per (studio, user).
 */
export function selectionKey(scope: SelectionScope): string {
  return `${scope.studioId}:${scope.practitionerId}`;
}

/**
 * A studio's PHYSICAL machine. Catalogue identity and device identity are
 * separate things: two rooms can hold the same model, a studio names its own
 * units, and installed options belong to the unit rather than to the model.
 */
export type StudioDevice = {
  deviceId: string;
  studioId: string;
  /** Which catalogue profile this unit is. */
  profileId: string;
  /** The contract version this device was registered against. */
  profileVersion: number;
  /** What the studio calls it, e.g. "Room 2 xCell". */
  displayName: string;
  /** Options physically present on THIS unit. */
  installedOptions: string[];
  /** Set once the unit leaves service. A retired device is never resolved. */
  retiredAt: string | null;
};

/** What persists between visits. Deliberately tiny. */
export type StoredSelection = {
  deviceId: string;
  /** The mode she last worked in, when she had chosen one. */
  modeKey: string | null;
};

/**
 * The persistence boundary. Both methods are scope-keyed, so an implementation
 * cannot accidentally read across practitioners.
 */
export type SelectionStore = {
  read(scope: SelectionScope): Promise<StoredSelection | null>;
  write(scope: SelectionScope, selection: StoredSelection | null): Promise<void>;
};

// ---------------------------------------------------------------------------

export type ResolvedSelection =
  /** Nothing remembered yet — the picker opens with no machine chosen. */
  | { state: "none" }
  /** Usable: an available device on an offered profile. */
  | {
      state: "ready";
      device: StudioDevice;
      profile: MachineProfile;
      /** Null when she has not chosen a mode yet. */
      mode: MachineMode | null;
    }
  /**
   * The remembered device is gone or retired. The UI must SAY so and require a
   * replacement; it must not fall through to another machine.
   */
  | { state: "unavailable"; deviceId: string; reason: string }
  /**
   * The device exists but its profile is not offered — evidence is incomplete
   * for that exact model, or the catalogue retired it to legacy-only.
   */
  | {
      state: "not-verified";
      device: StudioDevice;
      profile: MachineProfile | null;
      reason: string;
    };

/**
 * Resolve the remembered choice for one practitioner in one studio.
 *
 * Takes no client, no session and no chart. See the file header.
 */
export async function resolveSelection(
  scope: SelectionScope,
  devices: readonly StudioDevice[],
  store: SelectionStore,
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): Promise<ResolvedSelection> {
  const stored = await store.read(scope);
  if (!stored) return { state: "none" };

  // Only this studio's devices are candidates, whatever the store returned.
  const device = devices.find(
    (d) => d.deviceId === stored.deviceId && d.studioId === scope.studioId,
  );
  if (!device) {
    return {
      state: "unavailable",
      deviceId: stored.deviceId,
      reason:
        "That machine is no longer registered to this studio. Choose a replacement — nothing is selected for you.",
    };
  }
  if (device.retiredAt) {
    return {
      state: "unavailable",
      deviceId: device.deviceId,
      reason: `${device.displayName} was taken out of service. Choose a replacement — nothing is selected for you.`,
    };
  }

  const profile = profileById(device.profileId, catalogue);
  if (!profile) {
    return {
      state: "not-verified",
      device,
      profile: null,
      reason: `${device.displayName} points at an unknown profile '${device.profileId}'. An unsupported device is never offered as a verified named profile.`,
    };
  }
  if (profile.availability !== "active") {
    return {
      state: "not-verified",
      device,
      profile,
      reason:
        profile.availabilityReason ??
        `${profile.manufacturer} ${profile.model} is not offered for new capture.`,
    };
  }
  if (device.profileVersion !== profile.version) {
    return {
      state: "not-verified",
      device,
      profile,
      reason: `${device.displayName} was registered against contract version ${device.profileVersion}; the catalogue is at ${profile.version}. Re-confirm the machine's fields before charting — historical readings keep their own version.`,
    };
  }

  const mode =
    stored.modeKey == null
      ? null
      : (activeModes(profile).find((m) => m.key === stored.modeKey) ?? null);

  return { state: "ready", device, profile, mode };
}

// ---------------------------------------------------------------------------

export type SelectOutcome =
  | { ok: true; selection: StoredSelection }
  | {
      ok: false;
      code:
        | "unknown_device"
        | "cross_studio_device"
        | "device_retired"
        | "unknown_profile"
        | "profile_not_offered"
        | "stale_profile_version"
        | "unknown_mode"
        | "mode_requires_installed_option";
      message: string;
    };

/**
 * Remember a machine for this practitioner in this studio.
 *
 * Refuses rather than storing anything a later resolve would have to reject,
 * so an unusable selection never becomes the remembered one. Writes only after
 * every check passes.
 */
export async function selectDevice(
  scope: SelectionScope,
  deviceId: string,
  modeKey: string | null,
  devices: readonly StudioDevice[],
  store: SelectionStore,
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): Promise<SelectOutcome> {
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device) {
    return { ok: false, code: "unknown_device", message: `No device '${deviceId}'.` };
  }
  if (device.studioId !== scope.studioId) {
    return {
      ok: false,
      code: "cross_studio_device",
      message:
        "That machine belongs to another studio. A remembered choice never crosses studios.",
    };
  }
  if (device.retiredAt) {
    return {
      ok: false,
      code: "device_retired",
      message: `${device.displayName} is out of service.`,
    };
  }

  const profile = profileById(device.profileId, catalogue);
  if (!profile) {
    return {
      ok: false,
      code: "unknown_profile",
      message: `Unknown profile '${device.profileId}'.`,
    };
  }
  if (profile.availability !== "active") {
    return {
      ok: false,
      code: "profile_not_offered",
      message:
        profile.availabilityReason ??
        `${profile.manufacturer} ${profile.model} is not offered for new capture.`,
    };
  }
  if (device.profileVersion !== profile.version) {
    return {
      ok: false,
      code: "stale_profile_version",
      message: `Device registered against version ${device.profileVersion}; catalogue is at ${profile.version}.`,
    };
  }

  if (modeKey != null) {
    const mode = activeModes(profile).find((m) => m.key === modeKey);
    if (!mode) {
      return {
        ok: false,
        code: "unknown_mode",
        message: `'${profile.model}' does not offer mode '${modeKey}'. Modes are per exact model and never inherited from the family.`,
      };
    }
    if (
      mode.requiresInstalledOption &&
      !device.installedOptions.includes(mode.requiresInstalledOption)
    ) {
      return {
        ok: false,
        code: "mode_requires_installed_option",
        message: `${device.displayName} does not have the '${mode.requiresInstalledOption}' option installed.`,
      };
    }
  }

  const selection: StoredSelection = { deviceId, modeKey };
  await store.write(scope, selection);
  return { ok: true, selection };
}

/** Explicitly forget the remembered machine. The visible "Change machine" path. */
export async function clearSelection(
  scope: SelectionScope,
  store: SelectionStore,
): Promise<void> {
  await store.write(scope, null);
}

/**
 * The machines a practitioner may actually pick in this studio: present, in
 * service, and on an offered profile at the matching contract version.
 *
 * An empty list is a legitimate answer and the UI must say so plainly rather
 * than appearing broken — today the catalogue offers no profile at all, so this
 * returns nothing for every studio until a model's evidence is reviewed.
 */
export function selectableDevices(
  scope: SelectionScope,
  devices: readonly StudioDevice[],
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): Array<{ device: StudioDevice; profile: MachineProfile }> {
  return devices.flatMap((device) => {
    if (device.studioId !== scope.studioId || device.retiredAt) return [];
    const profile = profileById(device.profileId, catalogue);
    if (!profile || profile.availability !== "active") return [];
    if (device.profileVersion !== profile.version) return [];
    return [{ device, profile }];
  });
}
