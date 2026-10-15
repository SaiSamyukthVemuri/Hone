"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { activeModes, type MachineProfile } from "@/lib/machines/profile-contract";
import { validateSubmittedReadings } from "@/lib/machines/validate-submitted-readings";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import {
  latestRecordedSetup,
  publishedModesFor,
  readingsForBlock,
  recordSetupGroup,
  recordSetupSubmission,
  registerStudioMachine,
  retireStudioMachine,
  type MachineDb,
  type ReadingInputRow,
  type ReadingSubmission,
  type RecordedReading,
  type SetupSubmissionGroup,
} from "@/lib/machines/machine-queries";
import {
  resolveSelection,
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
import {
  inventoryUnavailable,
  listStudioDevices,
} from "@/lib/machines/studio-devices";
import { machinesByIds } from "@/lib/machines/machine-queries";
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
  /** The stored selection, ONLY when it is actually usable for charting. */
  remembered: { deviceId: string; modeKey: string | null } | null;
  /**
   * Set when the store holds a machine that cannot be used, with the reason.
   *
   * Forwarding the stored id raw made the panel show nothing chosen - because
   * `selectableDevices` excludes a retired, deregistered, unknown-profile or
   * stale-version unit - while still reporting a machine as remembered, and
   * with none of the explanation `resolveSelection` had already produced
   * (Codex, 1a39a51f).
   */
  rememberedUnavailable: { deviceId: string; reason: string } | null;
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
  /**
   * What is ALREADY RECORDED against the block being charted.
   *
   * THE DEFECT THIS CLOSES: a recorded capture was permanent and INVISIBLE.
   * `setup_capture_history_for_block` and `readingsForBlockAction` were both
   * built, granted and proved against Postgres, and neither reached a screen,
   * so after a page load the practitioner saw nothing and could only
   * re-record - appending a second immutable capture indistinguishable from a
   * genuine mid-treatment change - or guess.
   *
   * EMPTY WITHOUT A BLOCK ID, which is not a special case to apologise for: in
   * create mode the block has no row, so there is nothing recorded against it
   * yet, by definition.
   */
  recordedSetup: RecordedReading[];
  /**
   * Recorded unit id -> the studio's own name for it.
   *
   * Resolved here rather than in the component because only the server can see
   * a RETIRED unit: `listStudioMachines` excludes those in SQL so they cannot
   * reach a picker, which also meant nothing could NAME one. A studio with two
   * units of the same model needs the name most once one is out of service
   * (Codex, 27061e88).
   *
   * RENAMED from `priorUnitNames` when the recorded-setup surface landed. It
   * now names the units of BOTH reads plus the unusable stored selection, from
   * one lookup, so a name tied to the prior setup alone was misleading - and a
   * misleading field name on a clinical surface is worth a mechanical rename.
   */
  unitNames: Record<string, string>;
};

const ANONYMOUS: MachineSetupContext = {
  scope: null,
  devices: [],
  inventoryReason: null,
  remembered: null,
  rememberedUnavailable: null,
  persistence: NO_PERSISTENCE,
  catalogue: [],
  canManageMachines: false,
  priorSetup: [],
  recordedSetup: [],
  unitNames: {},
};

/** Everything the panel needs, derived entirely on the server. */
export async function loadMachineSetupContext(input: {
  /** Route values. Authorized below against the server-derived studio. */
  clientId: string;
  sessionId: string;
  /**
   * The settings block being charted, when one exists.
   *
   * FOLDED INTO THIS LOAD RATHER THAN A SECOND ACTION CALL, deliberately. The
   * panel loads on demand precisely because an extra server-action POST to
   * this route broke two browser specs - repeat-client-fast-charting
   * classifies any POST without an idempotencyKey as a source re-read, and
   * conditional-numbing-notes lost its save to a racing round trip. Reading
   * the block's captures in a SECOND call would reintroduce exactly that.
   */
  blockId?: string | null;
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

  // RESOLVED AGAINST THE CURRENT INVENTORY AND CATALOGUE, not forwarded raw.
  //
  // `resolveSelection` already distinguishes ready / unavailable /
  // not-verified and carries the reason for each; this loader used to skip it
  // and hand the panel the stored id whatever its state. The panel then
  // rendered no chosen machine - `selectableDevices` correctly excludes a
  // retired, deregistered, unknown-profile or stale-version unit - while the
  // status line still reported one as remembered, with no explanation
  // (Codex, 1a39a51f).
  let remembered: MachineSetupContext["remembered"] = null;
  let rememberedUnavailable: MachineSetupContext["rememberedUnavailable"] = null;
  let persistence = DATABASE_PERSISTENCE;
  try {
    if (inventoryUnavailable(inventory)) {
      // AN UNREADABLE INVENTORY IS NOT A DEREGISTRATION.
      //
      // `listStudioDevices` returns an EMPTY array with source "unreadable"
      // when the read itself fails. Resolving a stored selection against that
      // empty array concludes "no longer registered to this studio", which
      // asserts a fact from missing data: the unit's existence is unknown, not
      // disproved. studio-devices' own header already draws this distinction -
      // "emptiness here means nothing about the studio" - and this loader was
      // ignoring it (Codex, d3e8b17b).
      const stored = await store(db).read(scope);
      if (stored) {
        rememberedUnavailable = {
          deviceId: stored.deviceId,
          reason:
            "Your machines could not be read just now, so the one remembered for you could not be confirmed. Nothing is selected - try again before charting.",
        };
      }
    } else {
      const resolved = await resolveSelection(
        scope,
        inventory.devices,
        store(db),
        catalogue,
      );
      if (resolved.state === "ready") {
        remembered = {
          deviceId: resolved.device.deviceId,
          modeKey: resolved.mode?.key ?? null,
        };
      } else if (resolved.state === "unavailable") {
        rememberedUnavailable = {
          deviceId: resolved.deviceId,
          reason: resolved.reason,
        };
      } else if (resolved.state === "not-verified") {
        rememberedUnavailable = {
          deviceId: resolved.device.deviceId,
          reason: resolved.reason,
        };
      }
      // "none" leaves both null: nothing is stored, which is not a problem to
      // report.
    }
  } catch {
    // A failed read must not claim the choice is kept. The panel then says so.
    persistence = NO_PERSISTENCE;
  }

  const prior = await latestRecordedSetup(db, scope.studioId, input.clientId);
  const priorSetup = prior.ok ? prior.value : [];

  // ONE LOOKUP, for the two things that need to see a RETIRED unit.
  //
  // Both were unreachable before, for the same reason: every existing query
  // excluded retired units, so nothing could name one.
  //   1. next-visit guidance, which fell back to the model once the recorded
  //      unit was retired;
  //   2. the unavailable WORDING - `resolveSelection`'s "was taken out of
  //      service" branch cannot fire from here, because a retired unit is not
  //      in the device list it searches, so it said "no longer registered to
  //      this studio" instead. That asserts the unit does not exist when it
  //      does, which is the same error one layer up from the unreadable-
  //      inventory case above.
  //
  // Degrades silently: if this read fails, names are simply absent and the
  // wording stays as resolved. A failed cosmetic lookup must not cost the
  // practitioner the setup itself.
  // WHAT IS ALREADY RECORDED against the block being charted, read in the
  // SAME round trip. Empty without a block, which in create mode is simply
  // true: the block has no row, so nothing is recorded against it.
  //
  // Degrades to empty on a failed read rather than throwing. This surface is
  // reassurance - "here is what you have already recorded" - and a failed
  // cosmetic read must not cost her the chart.
  const recorded = input.blockId
    ? await readingsForBlock(db, input.blockId)
    : null;
  const recordedSetup = recorded?.ok ? recorded.value : [];

  const unitNames: Record<string, string> = {};
  const needNames = [
    ...priorSetup.map((r) => r.deviceId),
    // THE RECORDED BLOCK'S UNITS TOO, in the same lookup. A treatment recorded
    // on a unit that has since been retired is exactly the case that must
    // still name it, and only the server can see one.
    ...recordedSetup.map((r) => r.deviceId),
    ...(rememberedUnavailable ? [rememberedUnavailable.deviceId] : []),
  ].filter((id): id is string => typeof id === "string" && id.length > 0);

  if (needNames.length > 0) {
    const named = await machinesByIds(db, scope.studioId, needNames);
    if (named.ok) {
      for (const m of named.value) unitNames[m.deviceId] = m.displayName;
      if (rememberedUnavailable) {
        const stored = named.value.find(
          (m) => m.deviceId === rememberedUnavailable!.deviceId,
        );
        if (stored?.retiredAt) {
          rememberedUnavailable = {
            deviceId: stored.deviceId,
            reason: `${stored.displayName} was taken out of service. Choose a replacement - nothing is selected for you.`,
          };
        }
      }
    }
  }

  return {
    scope,
    devices: inventory.devices,
    inventoryReason: inventory.reason,
    remembered,
    rememberedUnavailable,
    persistence,
    catalogue,
    canManageMachines: who?.practitioner.role === "owner",
    priorSetup,
    recordedSetup,
    unitNames,
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

  // CONSUME A PUBLISHED CONTRACT; NEVER AUTHOR ONE.
  //
  // An earlier version of this action PUBLISHED the field contract as part of
  // registration. That was wrong in kind, not just in degree: the contract is
  // a GLOBAL product fact, so letting a studio owner write it meant one
  // tenant's owner could change the units and precision every other tenant
  // records against, and rewrite the meaning of a version under which readings
  // had already been captured. Publication is now deployment authority only
  // (`sync_machine_profile_contract`, granted to service_role).
  //
  // What registration does instead is REFUSE a unit the studio could not then
  // chart against. Recording fails closed without a published contract, so
  // without this check an owner could register a machine that silently cannot
  // be used, and discover it only at capture time.
  const published = await publishedModesFor(
    db,
    profile.profileId,
    profile.version,
  );
  if (!published.ok) {
    return { ok: false, code: "rejected", error: published.error };
  }
  const wanted = activeModes(profile).map((m) => m.key);
  const missing = wanted.filter((m) => !published.value.includes(m));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "rejected",
      error:
        `No published field contract covers ${profile.manufacturer} ${profile.model} ` +
        `version ${profile.version} (${missing.join(", ")}). A machine cannot be ` +
        `registered until its contract is published, because its settings could ` +
        `not then be recorded.`,
    };
  }

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

  // VALIDATE EVERY READING THROUGH THE PROFILE-AWARE VALIDATOR, then take the
  // field's unit and precision from what it resolved.
  //
  // An earlier version of this block derived the descriptor from
  // nativeFieldGroups and checked only that the field EXISTS. That was a
  // partial reimplementation of lib/machines/validate-reading.ts, which was
  // already written for exactly this and checks more than I had:
  //
  //   * malformed_value - a negative current or duration. The database has no
  //     equivalent constraint, so without this an impossible value becomes an
  //     IMMUTABLE clinical row through the ordinary UI;
  //   * stale_profile_version - the device is registered against a contract
  //     version, and `version` below is the DEVICE's, not the catalogue's. A
  //     direct action call bypasses selectableDevices, so without this the
  //     action could derive version-N units while the RPC stamps the row with
  //     the device's older version: a permanently mislabelled reading;
  //   * unknown_field / unknown_mode / channel bounds /
  //     mode_requires_installed_option, against the options the device
  //     actually has.
  //
  // Both gaps found by Codex at a66f5ec9. The lesson is the same one twice:
  // reach for the validator that exists rather than re-deriving a weaker
  // version of it at the call site.
  const checkedRows = validateSubmittedReadings(
    device,
    profile,
    input.modeKey,
    input.readings,
  );
  if ("error" in checkedRows) {
    return { ok: false, code: "rejected", error: checkedRows.error };
  }
  const rows = checkedRows.rows;

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

/**
 * Record ONE SAVE - every settings group the practitioner entered - atomically.
 *
 * WHY THIS EXISTS BESIDE `recordReadingsAction`. Several separate calls, one
 * per group, cannot have three properties that a save needs (Codex, #860
 * 6157725545): a failure on the third group cannot roll back the first two;
 * two groups claiming the same probe are two individually valid calls the
 * database cannot see as related; and a lost response is indistinguishable
 * from a deliberate second capture, so retrying was unsafe. One command, one
 * transaction, one retry key.
 *
 * `recordReadingsAction` is KEPT, and is not a special case of this. A group
 * recorded through it was recorded on its own, which is a true fact about it
 * and is why the capture's submission id is null there.
 *
 * EVERY GROUP IS VALIDATED BEFORE ANY IS SENT. A group that fails validation
 * must not be discovered after the request is in flight: the command would
 * refuse the whole save, which is correct, but the practitioner would have
 * waited for a round trip to be told something this process already knew.
 */
export async function recordSetupSubmissionAction(input: {
  blockId: string;
  machineId: string;
  modeKey: string;
  idempotencyKey: string;
  groups: Array<{
    groupKey: string;
    channels: number[];
    readings: ReadingSubmission[];
  }>;
}): Promise<
  ActionResult & {
    submissionId?: string;
    captures?: number;
    written?: number;
    reused?: boolean;
  }
> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }
  if (input.groups.length === 0) {
    return { ok: false, code: "rejected", error: "Nothing to save." };
  }
  if (input.groups.some((g) => g.readings.length === 0)) {
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

  const groups: SetupSubmissionGroup[] = [];
  for (const g of input.groups) {
    const checked = validateSubmittedReadings(
      device,
      profile,
      input.modeKey,
      g.readings,
    );
    if ("error" in checked) {
      return { ok: false, code: "rejected", error: checked.error };
    }
    groups.push({
      groupKey: g.groupKey,
      channels: g.channels,
      readings: checked.rows,
    });
  }

  // CROSS-GROUP CHANNEL EXCLUSIVITY IS NOT RE-IMPLEMENTED HERE. The command
  // enforces it, which is the point of having moved it there - a check in this
  // process is bypassed by anything calling the RPC directly, and a check in
  // both is two definitions of one rule. The form warns before the round trip
  // through `settingGroupIssues`; this relies on the database.
  const out = await recordSetupSubmission(db, {
    blockId: input.blockId,
    machineId: input.machineId,
    modeKey: input.modeKey,
    idempotencyKey: input.idempotencyKey,
    groups,
  });
  if (!out.ok) {
    return { ok: false, code: "rejected", error: out.error };
  }
  return {
    ok: true,
    submissionId: out.value.submissionId,
    captures: out.value.groups,
    written: out.value.readings,
    reused: out.value.reused,
  };
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
