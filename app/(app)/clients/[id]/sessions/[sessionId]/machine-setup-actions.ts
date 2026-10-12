"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { activeModes, type MachineProfile } from "@/lib/machines/profile-contract";
import { nativeFieldGroups } from "@/lib/machines/charting";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import {
  latestRecordedSetup,
  readingsForBlock,
  recordSetupGroup,
  registerStudioMachine,
  retireStudioMachine,
  type MachineDb,
  type ReadingInputRow,
  type ReadingSubmission,
  type RecordedReading,
} from "@/lib/machines/machine-queries";
import {
  selectDevice,
  selectableDevices,
  type SelectionScope,
  type StudioDevice,
} from "@/lib/machines/selection";
import {
  createDatabaseStore,
  createVerifyingStore,
  DATABASE_PERSISTENCE,
  NO_PERSISTENCE,
  PersistenceUnavailableError,
  ScopeMismatchError,
  type PersistenceCapability,
} from "@/lib/machines/selection-store";
import { listStudioDevices } from "@/lib/machines/studio-devices";
import { assertSessionForClient } from "@/lib/sessions/session-lineage";

// MPX-03 — the machine workflow's server surface.
//
// IDENTITY IS DERIVED, NEVER SUBMITTED - BUT THE SUBJECT OF THE CHART IS NOT
// IDENTITY, AND CONFLATING THE TWO CAUSED A REAL DEFECT.
//
// No action here accepts a studio id or a practitioner id: those are ACTOR
// facts, they come from `getCurrentPractitionerWithStudio`, and there is
// nothing for a client to forge.
//
// `loadMachineSetupContext` originally took no arguments at all, on the theory
// that accepting nothing is safest. It is not: with no client in scope the
// next-visit panel could only ask "what was recorded in this STUDIO", which in
// a multi-client studio is the wrong record and showed one client's settings on
// another's chart (Codex, 9c6fbbe5).
//
// Which client's chart is open is a ROUTE fact, not a claim of authority. The
// correct handling is the one every other charting action in this directory
// already uses since PR #286: take it, then AUTHORIZE it with
// `assertSessionForClient` against the server-derived studio. Accepting a
// parameter and trusting a parameter are different things. Identity comes from `getCurrentPractitionerWithStudio`, which
// validates the auth token against GoTrue on every request and re-checks the
// selected-studio cookie.
//
// AUTHORITY IS THE DATABASE'S. Every write calls a 0223 command that resolves
// the caller itself (`own_practitioner_in_studio` / `is_studio_owner`) and
// returns NULL or raises for anyone else. Direct table DML is revoked from
// every runtime role, so these commands are the only way in. The scope check in
// `createVerifyingStore` is a second, earlier refusal - deliberate repetition.
//
// THE SYNTHETIC PROFILE CANNOT REACH PRODUCTION. `catalogueForRuntime` is
// `server-only`, requires `HONE_SYNTHETIC_MACHINE_PROFILE === "1"`, and refuses
// production outright. The catalogue the client receives is whatever the SERVER
// decided, so the browser cannot enable anything.

/** The narrow slice of the Supabase client this workflow needs. */
async function machineDb(): Promise<MachineDb> {
  // ONE cast, at the seam. `MachineDb` names the two capabilities used - `rpc`
  // and a filtered `select` - rather than accepting a whole client, so a reader
  // can see the authority this module takes. The runtime object is the real
  // authenticated client; only the type is narrowed.
  return (await createClient()) as unknown as MachineDb;
}

async function identity(): Promise<SelectionScope | null> {
  const who = await getCurrentPractitionerWithStudio();
  if (!who) return null;
  return { studioId: who.studio.id, practitionerId: who.practitioner.id };
}

/** The real store, wrapped in the scope check. */
function store(db: MachineDb) {
  return createVerifyingStore(
    identity,
    createDatabaseStore(db, (scope) => scope.practitionerId),
  );
}

export type MachineSetupContext = {
  scope: SelectionScope | null;
  devices: StudioDevice[];
  /** Set when there is nothing to offer and the reason is worth showing. */
  inventoryReason: string | null;
  remembered: { deviceId: string; modeKey: string | null } | null;
  persistence: PersistenceCapability;
  /**
   * The catalogue the SERVER resolved. Carries the synthetic demo profile only
   * when the gate allowed it, which is why the client never holds the gate.
   */
  catalogue: MachineProfile[];
  /** Whether the caller may register or retire a machine. */
  canManageMachines: boolean;
  /** The most recent recorded setup in this studio, for next-visit prep. */
  priorSetup: RecordedReading[];
};

const ANONYMOUS: MachineSetupContext = {
  scope: null,
  devices: [],
  inventoryReason: null,
  remembered: null,
  persistence: NO_PERSISTENCE,
  catalogue: [],
  canManageMachines: false,
  priorSetup: [],
};

/** Everything the panel needs, derived entirely on the server. */
export async function loadMachineSetupContext(input: {
  /** Route values. Authorized below against the server-derived studio. */
  clientId: string;
  sessionId: string;
}): Promise<MachineSetupContext> {
  const scope = await identity();
  if (!scope) return ANONYMOUS;

  const who = await getCurrentPractitionerWithStudio();

  // The session must belong to BOTH this studio AND this route client, or the
  // prior-setup read below would be reading another client's chart. Throws.
  await assertSessionForClient(scope.studioId, input.clientId, input.sessionId);

  const db = await machineDb();
  const catalogue = [...catalogueForRuntime()];

  const inventory = await listStudioDevices(db, scope.studioId);

  let remembered: MachineSetupContext["remembered"] = null;
  let persistence = DATABASE_PERSISTENCE;
  try {
    const stored = await store(db).read(scope);
    remembered = stored
      ? { deviceId: stored.deviceId, modeKey: stored.modeKey }
      : null;
  } catch {
    // A failed read must not claim the choice is kept. The panel then says so.
    persistence = NO_PERSISTENCE;
  }

  const prior = await latestRecordedSetup(db, scope.studioId, input.clientId);

  return {
    scope,
    devices: inventory.devices,
    inventoryReason: inventory.reason,
    remembered,
    persistence,
    catalogue,
    canManageMachines: who?.practitioner.role === "owner",
    priorSetup: prior.ok ? prior.value : [],
  };
}

export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "unauthenticated" | "rejected" | "not_persisted";
      error: string;
    };

/** Remember a machine for the CALLER, in the caller's own studio. */
export async function rememberMachineSelectionAction(choice: {
  deviceId: string;
  modeKey: string | null;
}): Promise<ActionResult> {
  const scope = await identity();
  if (!scope) {
    return {
      ok: false,
      code: "unauthenticated",
      error: "Sign in to choose a machine.",
    };
  }

  const db = await machineDb();
  const inventory = await listStudioDevices(db, scope.studioId);

  try {
    const picked = await selectDevice(
      scope,
      choice.deviceId,
      choice.modeKey,
      inventory.devices,
      store(db),
      catalogueForRuntime(),
    );
    if (!picked.ok) return { ok: false, code: "rejected", error: picked.message };
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

/** Forget the remembered machine. The visible "Change machine" path. */
export async function clearMachineSelectionAction(): Promise<ActionResult> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }
  const db = await machineDb();
  try {
    await store(db).write(scope, null);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not clear it.";
    return { ok: false, code: "not_persisted", error: message };
  }
}

/**
 * Register a physical machine. OWNER ONLY, refused in the database.
 *
 * The profile must be one the server's own catalogue offers, so a client cannot
 * register a unit against an unverified or invented profile id.
 */
export async function registerMachineAction(input: {
  profileId: string;
  displayName: string;
  installedOptions?: string[];
}): Promise<ActionResult & { machineId?: string }> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }

  const profile = catalogueForRuntime().find(
    (p) => p.profileId === input.profileId,
  );
  if (!profile || profile.availability !== "active") {
    return {
      ok: false,
      code: "rejected",
      error:
        "That machine model is not offered yet. A model becomes available only after its evidence review.",
    };
  }

  const name = input.displayName.trim();
  if (name.length === 0 || name.length > 80) {
    return {
      ok: false,
      code: "rejected",
      error: "Give the machine a name between 1 and 80 characters.",
    };
  }

  const db = await machineDb();
  const made = await registerStudioMachine(db, {
    studioId: scope.studioId,
    profileId: profile.profileId,
    // The VERSION comes from the server's catalogue, never from the client, so
    // a unit cannot be registered against a contract version that does not
    // exist.
    profileVersion: profile.version,
    displayName: name,
    installedOptions: input.installedOptions ?? [],
  });
  if (!made.ok) return { ok: false, code: "rejected", error: made.error };
  return { ok: true, machineId: made.value };
}

/** Take a unit out of service. Owner only, refused in the database. */
export async function retireMachineAction(
  machineId: string,
): Promise<ActionResult> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }
  const db = await machineDb();
  const done = await retireStudioMachine(db, machineId);
  if (!done.ok) return { ok: false, code: "rejected", error: done.error };
  return { ok: true };
}

/**
 * Record one settings group against a treatment block.
 *
 * No studio is sent: the block determines it in the database, and a block in
 * another studio is refused there. The machine is required, and the readings
 * are validated against the server's own catalogue before the write, so a
 * field the model does not have never reaches the table.
 */
const OBSERVATION_SOURCES = [
  "practitioner-entered",
  "machine-displayed",
  "device-computed",
  "estimated",
] as const;

export async function recordReadingsAction(input: {
  blockId: string;
  machineId: string;
  modeKey: string;
  groupKey: string;
  channels: number[];
  readings: ReadingSubmission[];
}): Promise<ActionResult & { written?: number }> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }
  if (input.readings.length === 0) {
    return { ok: false, code: "rejected", error: "Nothing to save." };
  }

  const db = await machineDb();
  const inventory = await listStudioDevices(db, scope.studioId);
  const device = inventory.devices.find((d) => d.deviceId === input.machineId);
  if (!device) {
    return {
      ok: false,
      code: "rejected",
      error: "That machine is not registered to this studio.",
    };
  }

  const profile = catalogueForRuntime().find(
    (p) => p.profileId === device.profileId,
  );
  const mode = profile
    ? activeModes(profile).find((m) => m.key === input.modeKey)
    : undefined;
  if (!profile || !mode) {
    return {
      ok: false,
      code: "rejected",
      error: "That machine does not offer that mode.",
    };
  }

  // DERIVE every field descriptor from the profile the registered machine was
  // registered against. An unknown (group, stage, field) triple is refused
  // rather than stored, because the immutability trigger would make a wrong
  // one permanent.
  const contract = new Map(
    nativeFieldGroups(profile, mode).flatMap((g) =>
      g.fields.map((f) => [`${f.stageKey ?? ""}::${f.key}`, f] as const),
    ),
  );

  const rows: ReadingInputRow[] = [];
  for (const r of input.readings) {
    if (!OBSERVATION_SOURCES.includes(r.observationSource)) {
      return {
        ok: false,
        code: "rejected",
        error: "That is not a recognised way of observing a reading.",
      };
    }
    const field = contract.get(`${r.stageKey ?? ""}::${r.fieldKey}`);
    if (!field) {
      return {
        ok: false,
        code: "rejected",
        error: `${profile.manufacturer} ${profile.model} has no field "${r.fieldKey}" in this mode, so it cannot be recorded.`,
      };
    }
    rows.push({
      stageKey: field.stageKey,
      fieldKey: field.key,
      value: r.value,
      // The machine's own unit and precision, from the profile. Not the
      // caller's opinion of them.
      nativeUnit: field.unit,
      decimals: field.decimals,
      observationSource: r.observationSource,
    });
  }

  const written = await recordSetupGroup(db, {
    blockId: input.blockId,
    machineId: input.machineId,
    modeKey: input.modeKey,
    groupKey: input.groupKey,
    channels: input.channels,
    readings: rows,
  });
  if (!written.ok) {
    return { ok: false, code: "rejected", error: written.error };
  }
  return { ok: true, written: written.value };
}

/** Everything recorded against one block, for the chart being edited. */
export async function readingsForBlockAction(
  blockId: string,
): Promise<RecordedReading[]> {
  const scope = await identity();
  if (!scope) return [];
  const db = await machineDb();
  const got = await readingsForBlock(db, blockId);
  return got.ok ? got.value : [];
}

/** The profiles a practitioner may pick in this studio right now. */
export async function listSelectableForCaller(): Promise<
  Array<{ deviceId: string; displayName: string; profile: MachineProfile; modes: string[] }>
> {
  const scope = await identity();
  if (!scope) return [];
  const db = await machineDb();
  const inventory = await listStudioDevices(db, scope.studioId);
  return selectableDevices(scope, inventory.devices, catalogueForRuntime()).map(
    ({ device, profile }) => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      profile,
      modes: activeModes(profile).map((m) => m.key),
    }),
  );
}
