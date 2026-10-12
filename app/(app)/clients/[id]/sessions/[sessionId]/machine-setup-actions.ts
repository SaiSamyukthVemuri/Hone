"use server";

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  activeModes,
  type MachineProfile,
} from "@/lib/machines/profile-contract";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import {
  selectDevice,
  selectableDevices,
  type SelectionScope,
  type StudioDevice,
} from "@/lib/machines/selection";
import {
  createUnavailableStore,
  createVerifyingStore,
  NO_PERSISTENCE,
  PersistenceUnavailableError,
  ScopeMismatchError,
  type PersistenceCapability,
} from "@/lib/machines/selection-store";
import {
  listStudioDevices,
  inventoryUnavailable,
} from "@/lib/machines/studio-devices";

// MPX-03 — server-derived identity for the machine-first panel.
//
// WHY THIS EXISTS INSTEAD OF PROP PLUMBING. The obvious route was to read the
// identity in the session page and pass it down. That page is held by four
// other lanes at once - one with UNCOMMITTED work in it - and
// session-blocks-view.tsx by two more, so threading two props through them
// would have meant editing files other lanes are mid-change in, for a value the
// server can hand over directly.
//
// It is also the stronger shape. `loadMachineSetupContext` TAKES NO ARGUMENTS.
// There is no studio id and no practitioner id for a client to submit, so there
// is nothing to forge: identity comes from `getCurrentPractitionerWithStudio`,
// which validates the auth token against GoTrue on every request and re-checks
// the selected-studio cookie. `rememberMachineSelectionAction` takes only the
// device choice for the same reason. A test asserts both signatures carry no
// ownership field, so a later convenience parameter cannot quietly reopen it.
//
// Ownership is checked a SECOND time underneath, at the store boundary, by
// `createVerifyingStore`. That is deliberate repetition: the action is the only
// caller today, and a future one that forgets should still be refused.

export type MachineSetupContext = {
  /** Null when the request is not an authenticated practitioner. */
  scope: SelectionScope | null;
  devices: StudioDevice[];
  /** Set when the emptiness is a missing capability, not a bare studio. */
  inventoryReason: string | null;
  remembered: { deviceId: string; modeKey: string | null } | null;
  persistence: PersistenceCapability;
};

const ANONYMOUS: MachineSetupContext = {
  scope: null,
  devices: [],
  inventoryReason: null,
  remembered: null,
  persistence: NO_PERSISTENCE,
};

/** The real store today. Reads nothing; refuses to fake a write. */
function store(resolveIdentity: () => Promise<SelectionScope | null>) {
  return createVerifyingStore(resolveIdentity, createUnavailableStore());
}

async function identity(): Promise<SelectionScope | null> {
  const who = await getCurrentPractitionerWithStudio();
  if (!who) return null;
  return { studioId: who.studio.id, practitionerId: who.practitioner.id };
}

/**
 * Everything the panel needs, derived entirely on the server.
 *
 * Takes no arguments on purpose - see the header.
 */
export async function loadMachineSetupContext(): Promise<MachineSetupContext> {
  const scope = await identity();
  if (!scope) return ANONYMOUS;

  const inventory = await listStudioDevices(scope.studioId);
  const remembered = await store(identity).read(scope);

  return {
    scope,
    devices: inventory.devices,
    inventoryReason: inventoryUnavailable(inventory) ? inventory.reason : null,
    remembered,
    persistence: NO_PERSISTENCE,
  };
}

export type RememberResult =
  | { ok: true }
  | {
      ok: false;
      /** `not_persisted` is the expected outcome until the column exists. */
      code: "unauthenticated" | "rejected" | "not_persisted";
      error: string;
    };

/**
 * Remember a machine for the CALLER, in the caller's own studio.
 *
 * The input carries the choice and nothing else. Validation runs against the
 * server-derived scope, so a device belonging to another studio, a retired one,
 * an unverified profile or a mode needing an absent option is refused before
 * any write is attempted.
 */
export async function rememberMachineSelectionAction(choice: {
  deviceId: string;
  modeKey: string | null;
}): Promise<RememberResult> {
  const scope = await identity();
  if (!scope) {
    return {
      ok: false,
      code: "unauthenticated",
      error: "Sign in to choose a machine.",
    };
  }

  const inventory = await listStudioDevices(scope.studioId);

  try {
    const picked = await selectDevice(
      scope,
      choice.deviceId,
      choice.modeKey,
      inventory.devices,
      store(identity),
      MACHINE_CATALOGUE,
    );
    if (!picked.ok) {
      return { ok: false, code: "rejected", error: picked.message };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof PersistenceUnavailableError) {
      return { ok: false, code: "not_persisted", error: e.message };
    }
    if (e instanceof ScopeMismatchError) {
      return { ok: false, code: "rejected", error: e.message };
    }
    throw e;
  }
}

/**
 * The profiles a practitioner may pick in this studio right now, and the modes
 * each one offers. Read-only; used by the panel to render the picker without a
 * second identity round trip.
 */
export async function listSelectableForCaller(): Promise<
  Array<{ deviceId: string; displayName: string; profile: MachineProfile; modes: string[] }>
> {
  const scope = await identity();
  if (!scope) return [];
  const inventory = await listStudioDevices(scope.studioId);
  return selectableDevices(scope, inventory.devices, MACHINE_CATALOGUE).map(
    ({ device, profile }) => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      profile,
      modes: activeModes(profile).map((m) => m.key),
    }),
  );
}
