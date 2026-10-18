import { isDefinitiveDatabaseAnswer } from "./save-attempt";
import type { ReadingValue } from "./profile-contract";
import type { StudioDevice } from "./selection";

/**
 * MPX-03 — the data layer over 0223's four commands.
 *
 * WHY AN INJECTED CLIENT. Every function here takes the client rather than
 * building one. The server action passes the real authenticated Supabase
 * client; the DB lane passes a client bound to an isolated stack. The SAME code
 * therefore runs in the proof and in the product, which is the only way a test
 * can claim anything about what the mounted UI does.
 *
 * `MachineDb` is the narrow slice of the Supabase client used here - `rpc` and
 * `from(...).select(...)`. Typing it structurally rather than importing
 * `SupabaseClient` keeps this module testable without a browser or a cookie
 * store, and documents exactly how much authority it needs.
 *
 * WHAT THIS LAYER DOES NOT DO. It performs no authorization of its own. Every
 * command it calls resolves the caller in the database via
 * `own_practitioner_in_studio` or `is_studio_owner`, and the tables' direct DML
 * is revoked from every runtime role. A studio id passed here is a FILTER the
 * database re-checks, never a claim this layer is making.
 */

export type MachineDbError = {
  message: string;
  /**
   * The SQLSTATE or PostgREST code, when the request reached one of them.
   *
   * Carried so a caller can tell a DEFINITIVE database answer from a
   * transport failure that supabase-js reported in `error` rather than by
   * rejecting (Codex, #860 4301722737). Optional because a transport
   * failure is exactly the case that has none - see
   * `isDefinitiveDatabaseAnswer`.
   */
  code?: string | null;
} | null;

export type MachineDb = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: MachineDbError }>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        is: (
          column: string,
          value: null,
        ) => {
          order: (
            column: string,
            opts: { ascending: boolean },
          ) => Promise<{ data: unknown; error: MachineDbError }>;
        };
        order: (
          column: string,
          opts: { ascending: boolean },
        ) => {
          limit: (
            n: number,
          ) => Promise<{ data: unknown; error: MachineDbError }>;
        };
        // `gt` is the KEYSET predicate: "the page after the last id I saw".
        // Declared rather than cast around, because this type's narrowness is
        // the point - a shape it does not describe is a query this module has
        // no business performing, and `readingsForBlock` genuinely performs
        // this one now that it reads a block's readings COMPLETELY instead of
        // taking the first 500 (Codex, #860 4288424513).
        gt: (
          column: string,
          value: string,
        ) => {
          order: (
            column: string,
            opts: { ascending: boolean },
          ) => {
            limit: (
              n: number,
            ) => Promise<{ data: unknown; error: MachineDbError }>;
          };
        };
        // A SECOND `eq` IS THE ROUTE BINDING: "this block, in this session".
        // Declared rather than cast around, for the same reason as the rest
        // of this type - a shape it does not describe is a query this module
        // has no business performing - and this one it must perform, because
        // an application lineage check authorizes the route while only a
        // predicate binds the record to it (Codex, #860 4298457378).
        eq: (
          column: string,
          value: unknown,
        ) => {
          limit: (
            n: number,
          ) => Promise<{ data: unknown; error: MachineDbError }>;
        };
        // `in` is how a lookup names SPECIFIC units by id. Declared here
        // because the slice is deliberately narrow: a query shape this type
        // does not describe is one this module has no business performing.
        in: (
          column: string,
          values: readonly string[],
        ) => {
          limit: (
            n: number,
          ) => Promise<{ data: unknown; error: MachineDbError }>;
        };
      };
    };
  };
};

export type MachineOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /**
       * The request's fate is UNKNOWN - it may have committed.
       *
       * Set only where the distinction is load-bearing (a write carrying a
       * retry key). Absent means the caller has no reason to treat the
       * failure as anything but final; it is never a claim that the outcome
       * WAS definitive.
       */
      unresolved?: boolean;
    };

function fail(error: MachineDbError, fallback: string): string {
  return error?.message?.trim() || fallback;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

type MachineRow = {
  id: string;
  studio_id: string;
  machine_profile_id: string;
  machine_profile_version: number;
  display_name: string;
  installed_options: string[] | null;
  retired_at: string | null;
};

/**
 * The studio's live machines, newest display name order.
 *
 * Retired units are excluded by the query rather than filtered afterwards, so a
 * retired unit cannot reach a picker by accident. Historical readings still
 * reference it by id and are unaffected.
 */
export type MachineIdentity = {
  deviceId: string;
  displayName: string;
  retiredAt: string | null;
};

/**
 * Name specific units by id, INCLUDING retired ones.
 *
 * WHY THIS EXISTS SEPARATELY from `listStudioMachines`. That query excludes
 * retired units in SQL, deliberately, "so a retired unit cannot reach a picker
 * by accident" - and that guard is right. But it left the system unable to see
 * a retired unit AT ALL outside the historical rows that reference it by id,
 * which broke two things that both needed to name one:
 *
 *   - next-visit guidance fell back to the model name once the recorded unit
 *     was retired, so "Room 1" became "Permanence GEMM-16" exactly when a
 *     studio with two units most needed telling them apart;
 *   - `resolveSelection`'s "was taken out of service" branch was UNREACHABLE
 *     from the loader, because a retired remembered machine is not in the
 *     device list at all - so it reported "no longer registered to this
 *     studio", which says the unit does not exist when it does.
 *
 * Both are the same omission: a lookup by id is not a picker, and must not
 * inherit the picker's filter. This one takes explicit ids and is still
 * studio-scoped, so it can name a unit without ever offering one
 * (Codex, 27061e88).
 */
export async function machinesByIds(
  db: MachineDb,
  studioId: string,
  ids: readonly string[],
): Promise<MachineOutcome<MachineIdentity[]>> {
  if (ids.length === 0) return { ok: true, value: [] };
  const { data, error } = await db
    .from("studio_machines")
    .select("id, display_name, retired_at")
    .eq("studio_id", studioId)
    .in("id", [...new Set(ids)])
    .limit(200);
  if (error) {
    return { ok: false, error: fail(error, "Could not read machine names.") };
  }
  const rows = (data ?? []) as Array<{
    id: string;
    display_name: string;
    retired_at: string | null;
  }>;
  return {
    ok: true,
    value: rows.map((r) => ({
      deviceId: r.id,
      displayName: r.display_name,
      retiredAt: r.retired_at,
    })),
  };
}

export async function listStudioMachines(
  db: MachineDb,
  studioId: string,
): Promise<MachineOutcome<StudioDevice[]>> {
  const { data, error } = await db
    .from("studio_machines")
    .select(
      "id, studio_id, machine_profile_id, machine_profile_version, display_name, installed_options, retired_at",
    )
    .eq("studio_id", studioId)
    .is("retired_at", null)
    .order("display_name", { ascending: true });

  if (error) return { ok: false, error: fail(error, "Could not read machines.") };

  const rows = (data ?? []) as MachineRow[];
  return {
    ok: true,
    value: rows.map((r) => ({
      deviceId: r.id,
      studioId: r.studio_id,
      profileId: r.machine_profile_id,
      profileVersion: r.machine_profile_version,
      displayName: r.display_name,
      installedOptions: r.installed_options ?? [],
      retiredAt: r.retired_at,
    })),
  };
}

/** Register one physical unit. Owner-only, enforced in the database. */
export async function registerStudioMachine(
  db: MachineDb,
  input: {
    studioId: string;
    profileId: string;
    profileVersion: number;
    displayName: string;
    installedOptions?: string[];
  },
): Promise<MachineOutcome<string>> {
  const { data, error } = await db.rpc("register_studio_machine", {
    p_studio_id: input.studioId,
    p_machine_profile_id: input.profileId,
    p_machine_profile_version: input.profileVersion,
    p_display_name: input.displayName,
    p_installed_options: input.installedOptions ?? [],
  });
  if (error) {
    return { ok: false, error: fail(error, "Could not register the machine.") };
  }
  return { ok: true, value: String(data) };
}

/** Take a unit out of service. Owner-only; clears it from every UI default. */
export async function retireStudioMachine(
  db: MachineDb,
  machineId: string,
): Promise<MachineOutcome<boolean>> {
  const { data, error } = await db.rpc("retire_studio_machine", {
    p_machine_id: machineId,
  });
  if (error) {
    return { ok: false, error: fail(error, "Could not retire the machine.") };
  }
  return { ok: true, value: data === true };
}

// ---------------------------------------------------------------------------
// The remembered selection
// ---------------------------------------------------------------------------

/**
 * Remember a machine for the CALLER in one studio.
 *
 * `null` clears it. The command accepts no practitioner id, so this cannot
 * write anyone else's default; a caller with no membership in that studio gets
 * a null practitioner back rather than a write.
 */
export async function rememberMachine(
  db: MachineDb,
  input: { studioId: string; machineId: string | null; modeKey: string | null },
): Promise<MachineOutcome<boolean>> {
  const { data, error } = await db.rpc("set_own_default_machine", {
    p_studio_id: input.studioId,
    p_machine_id: input.machineId,
    p_mode_key: input.modeKey,
  });
  if (error) {
    return { ok: false, error: fail(error, "Could not remember that machine.") };
  }
  // NULL means "you are not an active member of that studio". Reporting it as
  // a refusal rather than a success is the whole point of returning it.
  return { ok: true, value: data != null };
}

type RememberedRow = {
  default_machine_id: string | null;
  default_machine_mode: string | null;
};

/** Read the caller's own remembered machine, by practitioner row id. */
export async function readRememberedMachine(
  db: MachineDb,
  practitionerId: string,
): Promise<MachineOutcome<{ machineId: string | null; modeKey: string | null }>> {
  const { data, error } = await db
    .from("practitioners")
    .select("default_machine_id, default_machine_mode")
    .eq("id", practitionerId)
    .order("id", { ascending: true })
    .limit(1);

  if (error) {
    return { ok: false, error: fail(error, "Could not read your machine.") };
  }
  const row = ((data ?? []) as RememberedRow[])[0];
  return {
    ok: true,
    value: {
      machineId: row?.default_machine_id ?? null,
      modeKey: row?.default_machine_mode ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/**
 * What a CLIENT may say about one reading: which field, what it read, and how
 * it was observed.
 *
 * Deliberately smaller than `ReadingInputRow` below. The field's native unit
 * and precision are properties of the MACHINE, so the server derives them from
 * the profile and the caller does not get to assert them - an earlier shape
 * accepted both and cast them straight into an append-only clinical row
 * (Codex, 9c6fbbe5).
 */
export type ReadingSubmission = {
  /** Null for a mode-level field. */
  stageKey: string | null;
  fieldKey: string;
  value: ReadingValue;
  observationSource: ReadingInputRow["observationSource"];
};

/**
 * WHERE A NUMBER CAME FROM. One definition, because two lists drift and this
 * one is checked on the way in and narrowed on the way out.
 *
 * It lives beside `ReadingInputRow` rather than beside the validator because
 * the validator already imports its types from here; the reverse edge is
 * type-only and erases, so there is no runtime cycle.
 */
export const OBSERVATION_SOURCES = [
  "practitioner-entered",
  "machine-displayed",
  "device-computed",
  "estimated",
] as const;

export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export type ReadingInputRow = {
  /** Null for a mode-level field. */
  stageKey: string | null;
  fieldKey: string;
  value: ReadingValue;
  nativeUnit: string;
  decimals: number;
  observationSource: ObservationSource;
};

/**
 * Record one settings group against a treatment block.
 *
 * The block determines the studio in the database, so no studio is sent. A
 * block or machine in another studio is refused there, not here.
 *
 * The payload keeps a value and a reasoned absence distinct: `value` is sent as
 * a string so a recorded zero survives (a bare `0` would be indistinguishable
 * from absent once JSON-coerced), and an absence sends `absence_reason` with no
 * value at all. The database's XOR constraint refuses anything else.
 */
export async function recordSetupGroup(
  db: MachineDb,
  input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    groupKey: string;
    channels: number[];
    readings: ReadingInputRow[];
  /**
   * THE AUTHORIZED ROUTE, required. The command refuses a block that is not
   * this session's and a session that is not this client's: studio
   * membership alone let a stale or tampered request append immutable
   * readings to another client's treatment (Codex, #860 4297032712).
   *
   * Required rather than optional so a caller cannot omit the binding and
   * silently get the old, unscoped behaviour back.
   */
  sessionId: string;
  clientId: string;
  },
): Promise<MachineOutcome<number>> {
  const payload = input.readings.map((r) => ({
    stage_key: r.stageKey,
    field_key: r.fieldKey,
    ...(r.value.kind === "value"
      ? { value: String(r.value.value) }
      : { absence_reason: r.value.reason }),
    native_unit: r.nativeUnit,
    decimals: r.decimals,
    observation_source: r.observationSource,
  }));

  const { data, error } = await db.rpc("record_treatment_setup_group", {
    p_block_id: input.blockId,
    p_studio_machine_id: input.machineId,
    p_mode_key: input.modeKey,
    p_group_key: input.groupKey,
    p_channels: input.channels,
    p_readings: payload,
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
  });
  if (error) {
    return { ok: false, error: fail(error, "Could not save those settings.") };
  }
  return { ok: true, value: Number(data ?? 0) };
}

/** One settings group of a whole-save submission. */
export type SetupSubmissionGroup = {
  groupKey: string;
  channels: number[];
  readings: ReadingInputRow[];
};

/** What the database says one Save produced. */
export type SetupSubmissionResult = {
  submissionId: string;
  /** Captures the submission holds, as the database counted them. */
  groups: number;
  readings: number;
  /**
   * True when the retry key matched an EXISTING submission.
   *
   * Nothing was written by this call and nothing was duplicated: an earlier
   * attempt committed and its answer was lost. The caller needs to know,
   * because "saved" and "already saved" are different facts about the record.
   */
  reused: boolean;
};

/**
 * Record ONE SAVE - every settings group the practitioner entered - atomically.
 *
 * The block determines the studio in the database, so no studio is sent. A
 * block or machine in another studio is refused there, not here.
 *
 * `idempotencyKey` identifies the SAVE, and the caller must reuse it on every
 * retry of that save: that is what makes a retry safe after a lost response.
 * `lib/machines/save-attempt.ts` owns its lifetime.
 *
 * The per-reading payload is identical to `recordSetupGroup`'s and for the same
 * reasons: `value` goes as a string so a recorded zero survives JSON, and an
 * absence sends `absence_reason` with no value at all.
 */
export async function recordSetupSubmission(
  db: MachineDb,
  input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    idempotencyKey: string;
    groups: SetupSubmissionGroup[];
  /**
   * THE AUTHORIZED ROUTE, required. The command refuses a block that is not
   * this session's and a session that is not this client's: studio
   * membership alone let a stale or tampered request append immutable
   * readings to another client's treatment (Codex, #860 4297032712).
   *
   * Required rather than optional so a caller cannot omit the binding and
   * silently get the old, unscoped behaviour back.
   */
  sessionId: string;
  clientId: string;
  },
): Promise<MachineOutcome<SetupSubmissionResult>> {
  const { data, error } = await db.rpc("record_treatment_setup_submission", {
    p_block_id: input.blockId,
    p_studio_machine_id: input.machineId,
    p_mode_key: input.modeKey,
    p_idempotency_key: input.idempotencyKey,
    p_groups: input.groups.map((g) => ({
      group_key: g.groupKey,
      channels: g.channels,
      readings: g.readings.map((r) => ({
        stage_key: r.stageKey,
        field_key: r.fieldKey,
        ...(r.value.kind === "value"
          ? { value: String(r.value.value) }
          : { absence_reason: r.value.reason }),
        native_unit: r.nativeUnit,
        decimals: r.decimals,
        observation_source: r.observationSource,
      })),
    })),
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
  });
  if (error) {
    // A TRANSPORT FAILURE IS NOT A REFUSAL (Codex, #860 4301722737).
    //
    // When the connection drops AFTER the command commits, supabase-js can
    // report it here in `error` rather than rejecting the promise. Returning
    // a plain failure told the entry the save was REFUSED, which unfreezes
    // the draft and releases the retry key; the next save mints a new key
    // and appends a DUPLICATE immutable capture. The throw path was already
    // handled - this is the same lost response wearing the other shape.
    return {
      ok: false,
      error: fail(error, "Could not save those settings."),
      unresolved: !isDefinitiveDatabaseAnswer(error),
    };
  }
  // SHAPE-CHECKED RATHER THAN CAST. The command returns a jsonb object; a
  // deployment where the migration has not been applied, or an older function
  // still resolving, hands back something else entirely. Casting that would
  // report a successful save with an undefined submission id.
  const row = data as Partial<Record<string, unknown>> | null;
  const submissionId = typeof row?.submission_id === "string" ? row.submission_id : null;
  if (!submissionId) {
    return {
      ok: false,
      error:
        "The save did not report which capture it created, so whether it was " +
        "recorded cannot be confirmed.",
      // UNRESOLVED, BECAUSE THE WRITE MAY HAVE COMMITTED (Codex, #860
      // 4305555266). This branch is reached when the RPC returned NO ERROR
      // and a response this module cannot read - a stale function, or an
      // unexpected shape - so the command may well have recorded the capture.
      // Omitting the flag mapped it to a DEFINITIVE rejection, which unfreezes
      // the draft and lets the retry key be discarded, so a later save appends
      // a duplicate capture. The message already says the outcome cannot be
      // confirmed; this makes the state machine agree with the sentence.
      unresolved: true,
    };
  }
  return {
    ok: true,
    value: {
      submissionId,
      groups: Number(row?.groups ?? 0),
      readings: Number(row?.readings ?? 0),
      reused: row?.reused === true,
    },
  };
}

export type RecordedReading = {
  blockId: string;
  /**
   * The atomic capture this reading belongs to. Every reading recorded by the
   * command has one; it is what makes a retrieved setup one coherent thing
   * rather than a per-field composite.
   */
  captureId: string | null;
  /** Which capture of this group within its block. 1-based; appends. */
  revision: number;
  /**
   * The PHYSICAL unit this was recorded on, as the capture pinned it.
   *
   * Carried because the profile is not enough: two rooms can hold the same
   * model, so "Permanence GEMM-16" does not tell a practitioner whether the
   * setup to reproduce was Room 1's unit or Room 2's. Both read paths emit it
   * and the composite FK now forces them to agree on it; dropping it here
   * threw that away at the last step (Codex, d3e8b17b).
   */
  deviceId: string;
  profileId: string;
  profileVersion: number;
  modeKey: string;
  groupKey: string;
  channels: number[];
  stageKey: string | null;
  fieldKey: string;
  value: ReadingValue;
  nativeUnit: string;
  decimals: number;
  /**
   * WHERE THE NUMBER CAME FROM, as the capture recorded it.
   *
   * THE RECORDED FACT, NOT THE CONTRACT'S EXPECTATION. The two are allowed to
   * differ: `validateReading` deliberately permits a mismatch and records what
   * actually happened, so a field the profile says is machine-displayed can
   * legitimately carry a practitioner-entered reading. Deriving this from
   * today's profile instead of reading it back therefore does not recover it -
   * it overwrites the exception with the rule, which is the one case where
   * provenance matters.
   *
   * The write path stored it and the SQL emitted it; the column list, this
   * type and `toReading` all dropped it, so both previous-treatment and
   * recorded-history lost it permanently at the application boundary
   * (Codex, #860 4294673727).
   *
   * Null only for a row recorded before the column existed.
   */
  observationSource: ObservationSource | null;
  recordedAt: string;
};

type ReadingRow = {
  session_block_id: string;
  machine_profile_id: string;
  machine_profile_version: number;
  mode_key: string;
  group_key: string;
  channels: number[] | null;
  stage_key: string | null;
  field_key: string;
  value_numeric: string | number | null;
  absence_reason: string | null;
  native_unit: string;
  decimals: number;
  revision: number;
  capture_id: string | null;
  studio_machine_id: string;
  observation_source: string | null;
  recorded_at: string;
};

function toReading(r: ReadingRow): RecordedReading {
  return {
    blockId: r.session_block_id,
    captureId: r.capture_id ?? null,
    // Which capture of this group this reading belongs to, within its block.
    // 1 is the first; a setting changed mid-treatment appends 2, and both
    // survive. Every field of ONE capture shares this number.
    revision: r.revision,
    deviceId: r.studio_machine_id,
    profileId: r.machine_profile_id,
    profileVersion: r.machine_profile_version,
    modeKey: r.mode_key,
    groupKey: r.group_key,
    channels: r.channels ?? [],
    stageKey: r.stage_key,
    fieldKey: r.field_key,
    // numeric comes back as a string from PostgREST; Number() here would lose
    // nothing for these magnitudes, but the string is parsed once and the
    // native precision is carried separately in `decimals` regardless.
    value:
      r.value_numeric != null
        ? { kind: "value", value: Number(r.value_numeric) }
        : {
            kind: "absent",
            reason:
              (r.absence_reason as "not-recorded" | "not-applicable" | "not-legible") ??
              "not-recorded",
          },
    nativeUnit: r.native_unit,
    decimals: r.decimals,
    // NARROWED AGAINST THE SAME LIST THE WRITE PATH VALIDATES, so an
    // unrecognised value becomes null rather than being asserted into the
    // union. A row written before the column existed is null too, and both
    // mean the same thing to a reader: provenance unknown, not assumed.
    observationSource: OBSERVATION_SOURCES.includes(
      r.observation_source as ObservationSource,
    )
      ? (r.observation_source as ObservationSource)
      : null,
    recordedAt: r.recorded_at,
  };
}

const READING_COLUMNS =
  "session_block_id, machine_profile_id, machine_profile_version, mode_key, " +
  "group_key, channels, stage_key, field_key, value_numeric, absence_reason, " +
  "native_unit, decimals, revision, capture_id, studio_machine_id, " +
  "observation_source, recorded_at";

/**
 * Is a contract PUBLISHED for this (profile, version)? Used to refuse
 * registering a unit the studio could not then record against.
 *
 * A read, available to any authenticated practitioner - the contract is a
 * product fact, not studio data.
 */
export async function publishedModesFor(
  db: MachineDb,
  profileId: string,
  profileVersion: number,
): Promise<MachineOutcome<string[]>> {
  const { data, error } = await db
    .from("machine_profile_mode_contract")
    .select("mode_key, machine_profile_version")
    .eq("machine_profile_id", profileId)
    .order("mode_key", { ascending: true })
    .limit(200);
  if (error) {
    return {
      ok: false,
      error: fail(error, "Could not read the published machine contract."),
    };
  }
  const rows = (data ?? []) as Array<{
    mode_key: string;
    machine_profile_version: number;
  }>;
  return {
    ok: true,
    value: rows
      .filter((r) => r.machine_profile_version === profileVersion)
      .map((r) => r.mode_key),
  };
}

/**
 * Publish the field contract for one (profile, version, mode) INTO THE
 * DATABASE, so `record_treatment_setup_group` can validate against it.
 *
 * DEPLOYMENT AUTHORITY ONLY. This is not reachable from a user session: the
 * command's EXECUTE is granted to `service_role` and revoked from
 * `authenticated`, because the contract is a GLOBAL product fact. An earlier
 * version let any active studio owner publish it, which meant one tenant's
 * owner could change the units and precision every other tenant records
 * against, and rewrite the meaning of a version under which readings had
 * already been captured.
 *
 * A published version is IMMUTABLE: identical content is an idempotent no-op,
 * different content is refused, and a correction means a NEW version.
 *
 * WHY THE DATABASE NEEDS ITS OWN COPY. The recording command is granted to
 * `authenticated` - it has to run as the practitioner for ownership to resolve
 * - so a studio member can call it directly, around the server action. While
 * the field contract lived only in TypeScript the command had nothing to check
 * against and took the caller's word for the field, its unit and its
 * precision, then made the row immutable. The application was validating; the
 * authority boundary was not.
 *
 * OWNER ONLY, enforced in the database. Publishing a contract is an
 * administrative act, like registering a unit, not part of charting.
 */
export async function publishMachineContract(
  db: MachineDb,
  input: {
    profileId: string;
    profileVersion: number;
    modeKey: string;
    /** Independently controlled outputs, or null if the model offers none. */
    channelsMax: number | null;
    /** A physical option the mode requires, or null. */
    requiresInstalledOption: string | null;
    fields: ReadonlyArray<{
      stageKey?: string | null;
      fieldKey: string;
      nativeUnit: string;
      decimals: number;
      quantity: string;
      /**
       * May a capture omit this field?
       *
       * Carried into the published contract because the RECORDING command
       * now refuses a capture missing a required field, and the contract is
       * the only place that knows which those are (Codex, #860 4299434251).
       * Omitted means REQUIRED, matching the column's default: a publisher
       * that forgets the flag gets the stricter reading.
       */
      optional?: boolean;
    }>;
  },
): Promise<MachineOutcome<number>> {
  const { data, error } = await db.rpc("sync_machine_profile_contract", {
    p_machine_profile_id: input.profileId,
    p_machine_profile_version: input.profileVersion,
    p_mode_key: input.modeKey,
    p_channels_max: input.channelsMax,
    p_requires_installed_option: input.requiresInstalledOption,
    p_fields: input.fields.map((f) => ({
      stage_key: f.stageKey ?? "",
      field_key: f.fieldKey,
      native_unit: f.nativeUnit,
      decimals: f.decimals,
      quantity: f.quantity,
      optional: f.optional ?? false,
    })),
  });
  if (error) {
    return {
      ok: false,
      error: fail(error, "Could not publish the machine's field contract."),
    };
  }
  return { ok: true, value: Number(data ?? 0) };
}

/** One keyset page of this read. 1,000 is PostgREST's own ceiling on Hone. */
export const BLOCK_READING_PAGE_SIZE = 1000;
/** 50 pages: past this the read is bounded out and fails closed. */
export const BLOCK_READING_MAX_PAGES = 50;

/**
 * Every reading recorded against one block, for the chart being edited.
 *
 * READ COMPLETELY OR NOT AT ALL, and the version this replaces was neither.
 * It asked for `.order("field_key").limit(500)`, which has two faults that
 * compound (Codex, #860 4288424513):
 *
 *   1. A BLOCK CAN EXCEED THE CAP. Each capture carries one row per field and a
 *      save appends one capture per settings group, so a four-channel unit
 *      re-read through a long treatment reaches several hundred rows without
 *      anything unusual happening.
 *   2. ORDERED BY `field_key` ALONE, the cap does not cut at a capture
 *      boundary - it cuts mid-alphabet across every capture at once. The
 *      surface groups these rows into captures, so the result is not "the last
 *      N captures missing" but captures rendered with SOME of their fields.
 *      A setup is only reproducible as a set: a current without its duration is
 *      not a setting anyone can repeat, and a capture silently missing a field
 *      reads as a complete record of a different treatment.
 *
 * AND RAISING THE LIMIT WOULD HAVE MOVED THE CLIFF, not removed it. PostgREST
 * answers a read past `max_rows` with 200, the first window and NO error, so
 * dropping `.limit(500)` just relocates the same silent truncation to 1,000.
 * That is the trap `lib/sms/suppression-candidates.ts` was written for, and
 * this uses its idiom: KEYSET pages by `id`, each after the last id seen, until
 * a page comes back EMPTY. A short page is never trusted to be the last one, so
 * a row limit below the page size cannot end the read early.
 *
 * FAIL-CLOSED. A failed page, a keyset that does not advance, or more pages
 * than the ceiling allows returns `{ ok: false }` - never a partial list
 * wearing `ok: true`. The caller already handles a failed read by saying so;
 * what it cannot do is notice that a successful one was incomplete.
 *
 * THE RETURNED ORDER IS UNCHANGED - sorted by `field_key` in memory - so the
 * rendering contract this read has always had is not quietly altered by the
 * repair.
 */
export async function readingsForBlock(
  db: MachineDb,
  blockId: string,
  /**
   * THE AUTHORIZED SESSION. Required, and checked against the block IN A
   * QUERY before anything is read.
   *
   * THE DEFECT THIS CLOSES, which is my own repair of the write path
   * repeated on the read (Codex, #860 4298457378). Round 8 added
   * `assertSessionForClient` to the read action and I reported the hole
   * closed. It was not: that call validates the SUPPLIED session and
   * client are a real pair for this studio — it says nothing about the
   * BLOCK. The read then filtered on the block id alone and the
   * studio-member SELECT policy admitted it, so a crafted request still
   * returned another client's captures and the chart rendered them under
   * "Recorded this treatment".
   *
   * An application lineage check authorizes the ROUTE. Only a predicate in
   * a query binds the record to it. That is the same sentence as the write
   * path's, and I wrote it there before making the opposite mistake here.
   *
   * WHY VERIFY-THEN-READ IS SOUND HERE and not a time-of-check race:
   * `session_blocks.session_id` is IMMUTABLE. A trigger refuses to move a
   * block between sessions ("A treatment record cannot be re-assigned"),
   * which this lane confirmed the hard way when that trigger rejected a
   * test fixture. The pair cannot change between the check and the read,
   * so one bounded lookup settles it for the whole paginated read that
   * follows.
   */
  sessionId: string,
): Promise<MachineOutcome<RecordedReading[]>> {
  // THE BINDING, AS A QUERY. Two predicates: this block, in this session.
  // RLS still scopes the row to the caller's studio, so a block outside it
  // is invisible here regardless.
  const bound = await db
    .from("session_blocks")
    .select("id")
    .eq("id", blockId)
    .eq("session_id", sessionId)
    .limit(1);
  if (bound.error) {
    return { ok: false, error: fail(bound.error, "Could not read settings.") };
  }
  if (!Array.isArray(bound.data) || bound.data.length === 0) {
    // DELIBERATELY THE SAME MESSAGE a missing block would give. Confirming
    // that the block exists but belongs to someone else is the fact this
    // check exists to withhold.
    return { ok: false, error: "Could not read settings." };
  }

  const rows: ReadingRow[] = [];
  let after: string | null = null;

  for (let page = 0; page < BLOCK_READING_MAX_PAGES; page += 1) {
    const base = db
      .from("treatment_setup_readings")
      .select(`id, ${READING_COLUMNS}`)
      .eq("session_block_id", blockId);
    // THE KEYSET PREDICATE applies only after the first page. Written as two
    // whole chains rather than a reassigned builder: `gt` narrows the shape,
    // so a `let` holding the pre-`gt` type cannot hold the post-`gt` one.
    const { data, error } = await (after === null
      ? base.order("id", { ascending: true }).limit(BLOCK_READING_PAGE_SIZE)
      : base
          .gt("id", after)
          .order("id", { ascending: true })
          .limit(BLOCK_READING_PAGE_SIZE));

    if (error) return { ok: false, error: fail(error, "Could not read settings.") };
    if (!Array.isArray(data)) {
      return { ok: false, error: fail(null, "Could not read settings.") };
    }
    // AN EMPTY PAGE ENDS THE READ. A short one does not: that is the whole
    // difference between this and the version it replaces.
    if (data.length === 0) break;

    const keyed = data as Array<ReadingRow & { id?: unknown }>;
    rows.push(...keyed);
    const last = keyed[keyed.length - 1]!.id;
    // The keyset must move forward, or the loop could re-read a page for ever.
    if (typeof last !== "string" || (after !== null && last <= after)) {
      return { ok: false, error: fail(null, "Could not read settings.") };
    }
    after = last;

    if (page === BLOCK_READING_MAX_PAGES - 1) {
      // The ceiling was reached with a full page still arriving, so this read
      // cannot be shown complete. Refusing is the only honest answer.
      return { ok: false, error: fail(null, "Could not read settings.") };
    }
  }

  rows.sort((a, b) => a.field_key.localeCompare(b.field_key));
  return { ok: true, value: rows.map(toReading) };
}

/**
 * NEXT-VISIT RETRIEVAL. The most recently recorded setup in this studio,
 * returned as the whole group rather than one field.
 *
 * Ordering is by `recorded_at` descending, which is sound because readings are
 * immutable - a recorded instant cannot be moved, so "most recent" is a fact
 * rather than a race. The whole block's readings come back together, because a
 * setup is only reproducible as a set: a current without its duration is not a
 * setting anyone can repeat.
 */
/**
 * This CLIENT's most recent recorded setup, for next-visit guidance.
 *
 * REQUIRES A CLIENT, and that is the whole point. The first version took only a
 * studio id and returned the newest reading anywhere in the studio, so opening
 * Ana's chart while Bea's block was newer showed Bea's settings as guidance for
 * Ana (Codex, 9c6fbbe5). PR #286 had already removed studio-only scoping from
 * the charting writes in this directory for exactly that reason; this had
 * reintroduced it on the read side.
 *
 * The scoping is done in SQL by `latest_setup_for_client`, over the
 * block-in-session lineage the schema guarantees, rather than by filtering
 * here - so a future caller cannot omit it. `clientId` is a route value, not a
 * claim of ownership: the caller authorizes it with assertSessionForClient
 * first, and the function re-checks studio membership itself.
 */
export async function latestRecordedSetup(
  db: MachineDb,
  studioId: string,
  clientId: string,
  /**
   * The session being charted, which this must NOT offer back as history.
   *
   * REQUIRED, and a positional parameter rather than an option, so the type
   * checker refuses a caller that forgets it. Without the exclusion the
   * lookup returned the client's newest capture full stop - including one
   * recorded minutes earlier in the session on screen, presented under copy
   * that says it is not today's entries (Codex, #860 4289974654).
   *
   * It is passed to SQL rather than filtered here, for the same reason the
   * client scoping is: the paragraph above this function says the scoping
   * lives in SQL "so a future caller cannot omit it", and a filter applied in
   * this wrapper would be exactly the omission it warns about.
   */
  excludeSessionId: string,
): Promise<MachineOutcome<RecordedReading[]>> {
  const { data, error } = await db.rpc("latest_setup_for_client", {
    p_studio_id: studioId,
    p_client_id: clientId,
    p_exclude_session_id: excludeSessionId,
  });

  if (error) {
    return { ok: false, error: fail(error, "Could not read the last setup.") };
  }
  const rows = ((data ?? []) as ReadingRow[]).map(toReading);
  return { ok: true, value: rows };
}
