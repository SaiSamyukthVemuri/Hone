"use server";

import { createClient } from "@/lib/supabase/server";
import { SETUP_GROUPS_MOVED } from "@/lib/machines/pending-setup";
import { recordedGroupsMoved } from "@/lib/machines/setting-groups";
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
import {
  assertSessionForClient,
  SessionLineageError,
} from "@/lib/sessions/session-lineage";

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
  /** The recorded-captures read failed; empty here would be a lie. */
  /**
   * The next-visit guidance read FAILED, as distinct from this client
   * having no previous treatment. See `recordedSetupUnavailable`; same
   * rule, different surface.
   */
  priorSetupUnavailable: boolean;
  recordedSetupUnavailable: boolean;
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
  priorSetupUnavailable: false,
  recordedSetupUnavailable: false,
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

  // THE SESSION ON SCREEN IS EXCLUDED, and `input.sessionId` is safe to pass
  // because `assertSessionForClient` above has already authorized it against
  // this studio and client - this is the same value, not a second claim.
  // Without it the guidance could be today's own capture (Codex, #860
  // 4289974654).
  const prior = await latestRecordedSetup(
    db,
    scope.studioId,
    input.clientId,
    input.sessionId,
  );
  const priorSetup = prior.ok ? prior.value : [];
  // AND WHETHER THAT READ FAILED, which an empty list cannot say.
  //
  // BEYOND THE REPORTED FINDING, and named as such. Codex found the
  // conflation on the recorded-history read (#860 4300759932); the
  // enumeration of every failure-to-empty conversion found this one, on
  // next-visit GUIDANCE. The harm is different and still real: a failed
  // read tells her this client has no previous treatment, so she charts
  // without reference to settings that exist and that she would otherwise
  // have worked from.
  //
  // Same shape as `recordedSetupUnavailable`, deliberately: one way of
  // saying "the surface could not answer" rather than two.
  const priorSetupUnavailable = !prior.ok;

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
  // A FAILED READ IS REPORTED, NOT FLATTENED TO EMPTY. This surface is
  // reassurance - "here is what you have already recorded" - and a failed
  // cosmetic read must not cost her the chart, so it still degrades rather
  // than throwing. What changed is that it no longer degrades to a LIE:
  // `[]` renders as "nothing recorded", which is the one message that invites
  // her to record again and append a second immutable capture
  // (Codex, #860 4290452722).
  //
  // NULL WHEN THERE IS NO BLOCK, which is a third state and genuinely empty:
  // in create mode the block has no row, so nothing is recorded against it and
  // nothing failed.
  // BOUND TO THE ROUTE'S SESSION. This call site was NOT named in the
  // finding - the enumeration of every action taking a block id found it -
  // and it is the one the panel uses on every open, so an unbound read here
  // renders another client's captures under "Recorded this treatment"
  // without anyone crafting a save at all.
  const recorded = input.blockId
    ? await readingsForBlock(db, input.blockId, input.sessionId)
    : null;
  const recordedSetup = recorded?.ok ? recorded.value : [];
  const recordedSetupUnavailable = recorded !== null && !recorded.ok;

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
    priorSetupUnavailable,
    recordedSetupUnavailable,
    unitNames,
  };
}

export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "unauthenticated" | "rejected" | "unknown" | "not_persisted";
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
  /**
   * EXACTLY ONE OF THE TWO (Codex, #860 4305780322). This door revises the
   * group `groupKey` names, or asks for a new one under the caller's own
   * placeholder - it never chooses an identity.
   */
  groupKey: string | null;
  newGroupRef: string | null;
  channels: number[];
  readings: ReadingSubmission[];
  /**
   * THE AUTHORIZED ROUTE, and the reason these are required.
   *
   * This action had no client or session context, so it could not apply the
   * `assertSessionForClient` lineage check the other charting actions use,
   * and `assert_setup_scope` derived only the block's studio. A practitioner
   * is a member of the WHOLE studio, so a stale page or a tampered request
   * carrying another client's block id appended IMMUTABLE readings to the
   * wrong client's treatment (Codex, #860 4297032712).
   *
   * They are checked twice on purpose: here, against the server-derived
   * studio, and again inside the command. The application check gives a
   * clear refusal; the SQL check is what stops a future caller from
   * omitting it.
   */
  clientId: string;
  sessionId: string;
}): Promise<ActionResult & { written?: number }> {
  const scope = await identity();
  if (!scope) {
    return { ok: false, code: "unauthenticated", error: "Sign in first." };
  }
  // THE ROUTE IS AUTHORIZED BEFORE ANYTHING IS WRITTEN. `assertSessionForClient`
  // resolves the session against the SERVER-DERIVED studio and this client,
  // so a block id from another client's chart cannot be smuggled in by a
  // stale page or a crafted call.
  await assertSessionForClient(scope.studioId, input.clientId, input.sessionId);
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
    newGroupRef: input.newGroupRef,
    sessionId: input.sessionId,
    clientId: input.clientId,
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
  /**
   * The recorded group keys the caller's draft was built from (Codex, #860
   * 4305780322).
   *
   * OPTIONAL, AND THAT IS DELIBERATE: the per-group action and older callers
   * do not send it, and a caller that cannot say what it saw must not be
   * silently blocked from saving. Absent means "no claim", and the check below
   * is skipped. What it buys when present is the staleness refusal.
   */
  expectedGroupKeys?: string[];
  idempotencyKey: string;
  groups: Array<{
    /**
     * EXACTLY ONE OF THE TWO (Codex, #860 4305780322). `groupKey` revises the
     * group it names; `newGroupRef` is the form's own local placeholder for a
     * group the DATABASE will name. The action does not reinterpret which is
     * which - it validates readings and passes identity through.
     */
    groupKey: string | null;
    newGroupRef: string | null;
    channels: number[];
    readings: ReadingSubmission[];
  }>;
  /**
   * THE AUTHORIZED ROUTE, and the reason these are required.
   *
   * This action had no client or session context, so it could not apply the
   * `assertSessionForClient` lineage check the other charting actions use,
   * and `assert_setup_scope` derived only the block's studio. A practitioner
   * is a member of the WHOLE studio, so a stale page or a tampered request
   * carrying another client's block id appended IMMUTABLE readings to the
   * wrong client's treatment (Codex, #860 4297032712).
   *
   * They are checked twice on purpose: here, against the server-derived
   * studio, and again inside the command. The application check gives a
   * clear refusal; the SQL check is what stops a future caller from
   * omitting it.
   */
  clientId: string;
  sessionId: string;
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
  // THE ROUTE IS AUTHORIZED BEFORE ANYTHING IS WRITTEN. `assertSessionForClient`
  // resolves the session against the SERVER-DERIVED studio and this client,
  // so a block id from another client's chart cannot be smuggled in by a
  // stale page or a crafted call.
  //
  // AND A REFUSAL HERE IS A REFUSAL, NOT AN UNKNOWN OUTCOME (Codex, #860
  // 4304930968). This throws, and the entry's `catch` maps a throw to the
  // unresolved state — which keeps the retry key and freezes the draft, the
  // machine and mode pickers, and the host's Cancel button. Nothing has been
  // written at this point, so there is nothing ambiguous to protect: she was
  // left with a form she could neither save nor dismiss, in which every
  // retry repeats the same lineage refusal and the state can never settle.
  //
  // That deadlock is a consequence of rounds 14 and 20 freezing each control
  // correctly for a genuinely unresolved save, with nothing distinguishing
  // that from a refusal that merely arrived the same way.
  //
  // CAUGHT BY TYPE, not with a blanket try/catch. Reporting a genuinely
  // ambiguous write as `rejected` is the opposite error, and it unfreezes
  // the draft and releases the key — the duplicate-capture defect rounds 16
  // and 17 closed.
  try {
    await assertSessionForClient(scope.studioId, input.clientId, input.sessionId);
  } catch (e) {
    if (e instanceof SessionLineageError) {
      return {
        ok: false,
        code: "rejected",
        error:
          "This treatment could not be confirmed as this client's. Reload the chart before saving again — nothing was recorded.",
      };
    }
    // ANYTHING ELSE KEEPS ITS THROW. An unrecognised failure here has not
    // been shown to be a non-write, and guessing in the unfreezing direction
    // is the direction that costs a duplicate clinical record.
    throw e;
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
      newGroupRef: g.newGroupRef,
      channels: g.channels,
      readings: checked.rows,
    });
  }

  // CROSS-GROUP CHANNEL EXCLUSIVITY IS NOT RE-IMPLEMENTED HERE. The command
  // enforces it, which is the point of having moved it there - a check in this
  // process is bypassed by anything calling the RPC directly, and a check in
  // both is two definitions of one rule. The form warns before the round trip
  // through `settingGroupIssues`; this relies on the database.
  // THE RECORDED GROUPS MUST NOT HAVE MOVED (Codex, #860 4305780322).
  //
  // Group identities are derived from the snapshot the caller's draft was
  // built from, so two page loads that both add a group both pick the SAME
  // next key - and `record_setup_group_in_scope` takes the second as the next
  // REVISION of the first. Two distinct probe sets merge into one timeline and
  // only the second's values read as current: a silent loss of what she
  // recorded first. `setting-groups.ts` already names that outcome for a
  // sibling case and calls it "one guard away from a corrupt clinical
  // record"; this is the guard, for the case that is actually reachable.
  //
  // COMPARED HERE RATHER THAN IN THE FORM, so the read and the write are one
  // request: the window is this function's own microseconds instead of a
  // user-visible round trip. It is still DETECTION - durable allocation of the
  // identity is the real fix and needs the command, which is 0223's to make.
  //
  // BLOCK-WIDE, not scope-wide, because revisions are allocated per (block,
  // group_key): a collision does not care which device or mode produced it.
  //
  // NARROWED TO THE REVISE PATH, now that identities are server-issued.
  //
  // A save made entirely of NEW groups cannot collide any more: the database
  // issues each key under a block-wide lock, so a draft built from a stale
  // snapshot still lands as its own distinct group. Refusing it would cost a
  // practitioner a reload in a case where nothing can go wrong, and a guard
  // that cries wolf gets ignored.
  //
  // A REVISE is still worth refusing. She decided to record a change relative
  // to the setup she was looking at; if that set has moved, her baseline has
  // moved with it. Nothing is lost either way - captures are append-only - but
  // being told to look again is the honest answer to a stale picture.
  if (input.expectedGroupKeys && groups.some((g) => g.groupKey !== null)) {
    const current = await readingsForBlock(db, input.blockId, input.sessionId);
    if (!current.ok) {
      // A READ THAT FAILED IS NOT A SET THAT MATCHES. Treating it as "no
      // change" would skip the guard exactly when the database is unhappy.
      return { ok: false, code: "rejected", error: SETUP_GROUPS_MOVED };
    }
    const seen = current.value.map((r) => r.groupKey);
    if (recordedGroupsMoved(input.expectedGroupKeys, seen)) {
      return { ok: false, code: "rejected", error: SETUP_GROUPS_MOVED };
    }
  }

  const out = await recordSetupSubmission(db, {
    blockId: input.blockId,
    machineId: input.machineId,
    modeKey: input.modeKey,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    clientId: input.clientId,
    groups,
  });
  if (!out.ok) {
    // UNKNOWN IS NOT REJECTED. Collapsing the two here would discard the
    // distinction the query just preserved, one layer above it.
    return {
      ok: false,
      code: out.unresolved ? "unknown" : "rejected",
      error: out.error,
    };
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
export async function readingsForBlockAction(input: {
  blockId: string;
  clientId: string;
  sessionId: string;
}): Promise<ReadingsRead> {
  const scope = await identity();
  // NOT SIGNED IN is a FAILURE, not an empty treatment. It reaches the same
  // surface as a failed query and must not read as "nothing recorded".
  if (!scope) return { ok: false };
  // BEYOND THE REPORTED FINDING, and deliberately. Codex named the WRITE
  // path (#860 4297032712), but this read took a bare block id with no
  // lineage check either: the member-scoped SELECT policy admits any block
  // in the studio, so another client's recorded settings were readable by
  // id. That is the same hole pointed at a different verb, and leaving it
  // for a later round would mean knowingly shipping a clinical read with no
  // route binding.
  // TWO CHECKS, AND THEY ANSWER DIFFERENT QUESTIONS. This one authorizes the
  // ROUTE: that this session really is this client's, in this studio. It says
  // nothing about the block, which is exactly the mistake round 8 made here -
  // the check was added, the hole was reported closed, and the read still
  // filtered on an unbound block id (Codex, #860 4298457378).
  await assertSessionForClient(scope.studioId, input.clientId, input.sessionId);
  const db = await machineDb();
  // ...and this one binds the BLOCK to that session, in the query.
  const got = await readingsForBlock(db, input.blockId, input.sessionId);
  // A FAILED READ IS REPORTED AS ONE.
  //
  // This returned `[]` on failure, and round 11's post-save refresh then
  // installed that empty list over the real history while leaving
  // `recordedSetupUnavailable` false — so a transient read failure made the
  // "Recorded this treatment" list VANISH right after a save, which is the
  // one message that invites a second immutable capture
  // (Codex, #860 4300759932).
  //
  // THAT IS ROUND 4'S CONFLATION, ONE LAYER DOWN. I fixed "a failed read
  // must not render as nothing recorded" in the component and then
  // reintroduced it in the action feeding the component. The `catch` I
  // wrote around the refresh could never fire, because this never threw.
  //
  // The caller decides what to do with a failure; this one's job is to stop
  // pretending there was none.
  if (!got.ok) return { ok: false };

  // AND THE UNIT NAMES FOR WHAT CAME BACK (Codex, #860 4301669061).
  //
  // The refresh used to return readings alone, so a capture saved against a
  // unit that was not already in the loader's map arrived NAMELESS: the
  // history showed a new entry with no physical machine against it until a
  // reload. In a studio running two units of the same model that is the one
  // thing the entry is there to tell her, and after switching units and
  // saving again she has two unattributed captures.
  //
  // RESOLVED SERVER-SIDE for the same reason the loader does it: a RETIRED
  // unit is excluded from `listStudioMachines` in SQL, so nothing on the
  // client can name one, and a treatment recorded on a unit since taken out
  // of service is exactly the case that must still name it.
  const unitNames: Record<string, string> = {};
  const ids = got.value
    .map((r) => r.deviceId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length > 0) {
    const named = await machinesByIds(db, scope.studioId, ids);
    // A FAILED NAME LOOKUP IS NOT A FAILED READ. Losing the history is far
    // worse than an unnamed unit, so the readings are returned either way
    // and the caller MERGES, keeping whatever names it already had.
    if (named.ok) for (const m of named.value) unitNames[m.deviceId] = m.displayName;
  }
  return { ok: true, readings: got.value, unitNames };
}

/**
 * The outcome of reading what is recorded against a block.
 *
 * A DISCRIMINATED RESULT rather than an array, because the two cases that
 * an array conflates are exactly the two that matter clinically: "nothing
 * is recorded on this treatment" and "I could not find out". The second
 * must never render as the first.
 */
export type ReadingsRead =
  | {
      ok: true;
      readings: RecordedReading[];
      /**
       * Recorded unit id -> the studio's own name, for the readings above.
       *
       * PARTIAL BY DESIGN, and the caller must MERGE rather than replace:
       * this covers only the refreshed block, while the loader's map also
       * names the next-visit guidance and an unusable stored selection.
       * Replacing would name the new capture and un-name the prior setup.
       */
      unitNames: Record<string, string>;
    }
  | { ok: false };

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
