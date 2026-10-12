import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";
import {
  latestRecordedSetup,
  listStudioMachines,
  readRememberedMachine,
  readingsForBlock,
  recordSetupGroup,
  registerStudioMachine,
  rememberMachine,
  retireStudioMachine,
  type MachineDb,
} from "@/lib/machines/machine-queries";
import { listStudioDevices } from "@/lib/machines/studio-devices";
import {
  createDatabaseStore,
  createVerifyingStore,
  PersistenceUnavailableError,
  ScopeMismatchError,
} from "@/lib/machines/selection-store";
import { resolveSelection, selectableDevices } from "@/lib/machines/selection";
import { nativeFieldGroups, priorSetupView } from "@/lib/machines/charting";
import type { MachineProfile } from "@/lib/machines/profile-contract";

// ===========================================================================
// MPX-03 — the whole machine workflow, end to end, against a real database.
//
// WHAT MAKES THIS DIFFERENT from the 0223 storage test. That one calls the SQL
// commands directly. This one runs `lib/machines/machine-queries.ts` - the
// exact module the mounted server actions delegate to - so the code under test
// is the code the product runs. The actions themselves add only identity
// resolution, which is proved separately with a mocked session in
// tests/app/machines/.
//
// HOW A POSTGREST-SHAPED LAYER IS EXERCISED OVER pg. `MachineDb` is a narrow
// structural type (`rpc` plus a filtered `select`) precisely so it can be
// backed by anything. The adapter below implements it over the harness's
// authenticated pg connection, which is STRONGER than a service-role REST
// client would be: service_role deliberately holds no EXECUTE on these
// commands, so the only way to call them is as a real `authenticated`
// practitioner with RLS in force. That is what this adapter is.
//
// SYNTHETIC PROFILE ONLY. Every profile id here is `synthetic:` or `fixture:`.
// Nothing activates a real model; `machine_profile_id` is unconstrained TEXT in
// the schema exactly so activation stays an evidence review.
//
// SCOPE LIMIT, STATED: this proves the data path the UI uses, and the rendered
// markup produced from it. It is NOT a browser test - no Playwright lane runs
// here, so "through the mounted UI" means the mount's own code path, not a real
// click.
// ===========================================================================

const SYNTH: MachineProfile = {
  profileId: "synthetic:e2e-demo",
  version: 1,
  family: "Permanence/GEMM-16",
  manufacturer: "Synthetic",
  model: "E2E Demo",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "s",
      kind: "studio-device-photo",
      consultedOn: "2026-10-12",
      establishes: "Nothing about any real machine.",
    },
  ],
  openQuestions: [],
  channels: {
    count: 4,
    nativeLabel: "Channel",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: ["s"],
  },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["s"],
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          quantity: "current",
          unit: "µA",
          decimals: 0,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["s"],
        },
        {
          key: "duration",
          nativeLabel: "Time",
          quantity: "duration",
          unit: "s",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["s"],
        },
      ],
    },
  ],
};

const CAT = [SYNTH];

afterAll(async () => {
  await closePool();
});

/**
 * `MachineDb` over an authenticated pg connection.
 *
 * Only the shapes the data layer actually uses are implemented, and anything
 * else throws rather than silently returning nothing — a double that answers
 * calls it was never taught is how a test starts passing for the wrong reason.
 */
function pgMachineDb(q: UserQuery): MachineDb {
  const run = async (sql: string, params: unknown[]) => {
    try {
      const r = await q(sql, params);
      return { data: r.rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };

  return {
    async rpc(fn, args) {
      const names = Object.keys(args);
      const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
      const out = await run(
        `select public.${fn}(${placeholders}) as result`,
        names.map((n) => {
          const v = args[n];
          // jsonb and smallint[] both arrive as JS arrays; the readings payload
          // must go as JSON text, the channels as a pg array literal.
          if (n === "p_readings") return JSON.stringify(v);
          return v;
        }),
      );
      if (out.error) return { data: null, error: out.error };
      return {
        data: (out.data as Array<{ result: unknown }>)[0]?.result ?? null,
        error: null,
      };
    },
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              const base = `select ${columns} from public.${table} where ${column} = $1`;
              return {
                is(nullCol) {
                  return {
                    order(orderCol, opts) {
                      return run(
                        `${base} and ${nullCol} is null order by ${orderCol} ${
                          opts.ascending ? "asc" : "desc"
                        }`,
                        [value],
                      );
                    },
                  };
                },
                order(orderCol, opts) {
                  return {
                    limit(n) {
                      return run(
                        `${base} order by ${orderCol} ${
                          opts.ascending ? "asc" : "desc"
                        } limit ${n}`,
                        [value],
                      );
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

/** Run the data layer as one practitioner, with RLS in force. */
function asDb<T>(userId: string, fn: (db: MachineDb) => Promise<T>): Promise<T> {
  return asUser(userId, (q) => fn(pgMachineDb(q)));
}

async function registerSynthetic(
  studio: SeededStudio,
  name: string,
): Promise<string> {
  return asDb(studio.userId, async (db) => {
    const made = await registerStudioMachine(db, {
      studioId: studio.studioId,
      profileId: SYNTH.profileId,
      profileVersion: SYNTH.version,
      displayName: name,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  });
}

const READINGS = [
  {
    stageKey: null,
    fieldKey: "current",
    value: { kind: "value" as const, value: 120 },
    nativeUnit: "µA",
    decimals: 0,
    observationSource: "practitioner-entered" as const,
  },
  {
    stageKey: null,
    fieldKey: "duration",
    value: { kind: "value" as const, value: 300.5 },
    nativeUnit: "s",
    decimals: 1,
    observationSource: "practitioner-entered" as const,
  },
];

// ---------------------------------------------------------------------------

describe("MPX-03 · the inventory reader reads real rows", () => {
  it("registers a machine and reads it back as a selectable device", async () => {
    const studio = await seedStudio("e2e-inv");
    const id = await registerSynthetic(studio, "Room 1");

    const inv = await asDb(studio.userId, (db) =>
      listStudioDevices(db, studio.studioId),
    );
    expect(inv.source).toBe("ok");
    expect(inv.devices).toHaveLength(1);
    expect(inv.devices[0]!.deviceId).toBe(id);
    expect(inv.devices[0]!.displayName).toBe("Room 1");
    expect(inv.devices[0]!.profileId).toBe(SYNTH.profileId);
    expect(inv.devices[0]!.profileVersion).toBe(1);

    // And it is genuinely offerable: the catalogue says active, the version
    // matches, the studio matches.
    const offerable = selectableDevices(
      { studioId: studio.studioId, practitionerId: studio.practitionerId },
      inv.devices,
      CAT,
    );
    expect(offerable).toHaveLength(1);
  });

  it("a studio with nothing registered reports empty, not unreadable", async () => {
    const studio = await seedStudio("e2e-inv-empty");
    const inv = await asDb(studio.userId, (db) =>
      listStudioDevices(db, studio.studioId),
    );
    expect(inv.devices).toEqual([]);
    expect(inv.source).toBe("empty-for-studio");
  });

  it("a retired machine leaves the inventory", async () => {
    const studio = await seedStudio("e2e-inv-retire");
    const id = await registerSynthetic(studio, "Room 1");
    await asDb(studio.userId, (db) => retireStudioMachine(db, id));
    const inv = await asDb(studio.userId, (db) =>
      listStudioDevices(db, studio.studioId),
    );
    expect(inv.devices).toEqual([]);
    expect(inv.source).toBe("empty-for-studio");
  });

  it("another studio's machines are invisible", async () => {
    const mine = await seedStudio("e2e-inv-a");
    const other = await seedStudio("e2e-inv-b");
    await registerSynthetic(other, "Their room");
    const inv = await asDb(mine.userId, (db) =>
      listStudioDevices(db, mine.studioId),
    );
    expect(inv.devices).toEqual([]);
  });

  it("a NON-OWNER cannot register one through the data layer", async () => {
    const studio = await seedStudio("e2e-inv-nonowner");
    const member = await seedMember(studio, "plain");
    const out = await asDb(member.userId, (db) =>
      registerStudioMachine(db, {
        studioId: studio.studioId,
        profileId: SYNTH.profileId,
        profileVersion: 1,
        displayName: "Smuggled",
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/only the studio owner/i);
  });
});

describe("MPX-03 · the remembered selection SAVES and RELOADS through the store", () => {
  it("saves, then reloads on a fresh connection, then resolves to ready", async () => {
    const studio = await seedStudio("e2e-remember");
    const id = await registerSynthetic(studio, "Room 1");
    const scope = {
      studioId: studio.studioId,
      practitionerId: studio.practitionerId,
    };

    // SAVE through the production store, wrapped in the real scope check.
    await asDb(studio.userId, (db) =>
      createVerifyingStore(
        async () => scope,
        createDatabaseStore(db, (s) => s.practitionerId),
      ).write(scope, { deviceId: id, modeKey: "galvanic" }),
    );

    // RELOAD on a brand-new connection and transaction.
    const reloaded = await asDb(studio.userId, (db) =>
      createVerifyingStore(
        async () => scope,
        createDatabaseStore(db, (s) => s.practitionerId),
      ).read(scope),
    );
    expect(reloaded).toEqual({ deviceId: id, modeKey: "galvanic" });

    // And the full resolver answers "ready" with the right device and mode.
    const resolved = await asDb(studio.userId, async (db) => {
      const inv = await listStudioDevices(db, scope.studioId);
      return resolveSelection(
        scope,
        inv.devices,
        createVerifyingStore(
          async () => scope,
          createDatabaseStore(db, (s) => s.practitionerId),
        ),
        CAT,
      );
    });
    expect(resolved.state).toBe("ready");
    if (resolved.state === "ready") {
      expect(resolved.device.deviceId).toBe(id);
      expect(resolved.mode?.key).toBe("galvanic");
    }
  });

  it("the raw column agrees with what the store reported", async () => {
    const studio = await seedStudio("e2e-remember-raw");
    const id = await registerSynthetic(studio, "Room 1");
    await asDb(studio.userId, (db) =>
      rememberMachine(db, {
        studioId: studio.studioId,
        machineId: id,
        modeKey: "galvanic",
      }),
    );
    const row = await adminQuery(
      `select default_machine_id, default_machine_mode
         from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(row.rows[0].default_machine_id).toBe(id);
    expect(row.rows[0].default_machine_mode).toBe("galvanic");
  });

  it("ISOLATES two practitioners in one studio", async () => {
    const studio = await seedStudio("e2e-iso");
    const member = await seedMember(studio, "second");
    const a = await registerSynthetic(studio, "Room A");
    const b = await registerSynthetic(studio, "Room B");

    await asDb(studio.userId, (db) =>
      rememberMachine(db, { studioId: studio.studioId, machineId: a, modeKey: null }),
    );
    await asDb(member.userId, (db) =>
      rememberMachine(db, { studioId: studio.studioId, machineId: b, modeKey: null }),
    );

    const mineBack = await asDb(studio.userId, (db) =>
      readRememberedMachine(db, studio.practitionerId),
    );
    const theirsBack = await asDb(member.userId, (db) =>
      readRememberedMachine(db, member.practitionerId),
    );
    expect(mineBack.ok && mineBack.value.machineId).toBe(a);
    expect(theirsBack.ok && theirsBack.value.machineId).toBe(b);
  });

  it("a non-member's write is refused, not silently dropped", async () => {
    const mine = await seedStudio("e2e-nonmember-a");
    const theirs = await seedStudio("e2e-nonmember-b");
    const scopeInTheirs = {
      studioId: theirs.studioId,
      practitionerId: theirs.practitionerId,
    };
    // Alice's session, Bob's studio: the command resolves membership FIRST and
    // returns NULL before it ever looks at the machine, so the store turns that
    // into a refusal rather than a quiet success. A VALID uuid is used on
    // purpose - a malformed one would raise a type error earlier and this would
    // pass for the wrong reason.
    await expect(
      asDb(mine.userId, (db) =>
        createDatabaseStore(db, (s) => s.practitionerId).write(scopeInTheirs, {
          deviceId: randomUUID(),
          modeKey: null,
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeMismatchError);
  });

  it("a machine from another studio is refused by the database", async () => {
    const mine = await seedStudio("e2e-xs-a");
    const theirs = await seedStudio("e2e-xs-b");
    const theirMachine = await registerSynthetic(theirs, "Their room");
    const out = await asDb(mine.userId, (db) =>
      rememberMachine(db, {
        studioId: mine.studioId,
        machineId: theirMachine,
        modeKey: null,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/belongs to another studio/i);
  });

  it("clearing removes both halves", async () => {
    const studio = await seedStudio("e2e-clear");
    const id = await registerSynthetic(studio, "Room 1");
    const scope = {
      studioId: studio.studioId,
      practitionerId: studio.practitionerId,
    };
    await asDb(studio.userId, (db) =>
      createDatabaseStore(db, (s) => s.practitionerId).write(scope, {
        deviceId: id,
        modeKey: "galvanic",
      }),
    );
    await asDb(studio.userId, (db) =>
      createDatabaseStore(db, (s) => s.practitionerId).write(scope, null),
    );
    const back = await asDb(studio.userId, (db) =>
      createDatabaseStore(db, (s) => s.practitionerId).read(scope),
    );
    expect(back).toBeNull();
  });
});

describe("MPX-03 · readings SAVE and are RETRIEVED for the chart", () => {
  it("saves a group and reads it back for the same block", async () => {
    const studio = await seedStudio("e2e-read");
    const { blockId } = await seedSession(studio);
    const id = await registerSynthetic(studio, "Room 1");

    const wrote = await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [1, 2],
        readings: READINGS,
      }),
    );
    expect(wrote.ok && wrote.value).toBe(2);

    const back = await asDb(studio.userId, (db) => readingsForBlock(db, blockId));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const byField = new Map(back.value.map((r) => [r.fieldKey, r]));
    // Native unit and precision survive the whole round trip.
    expect(byField.get("current")!.nativeUnit).toBe("µA");
    expect(byField.get("current")!.value).toEqual({ kind: "value", value: 120 });
    expect(byField.get("duration")!.value).toEqual({ kind: "value", value: 300.5 });
    expect(byField.get("duration")!.decimals).toBe(1);
    expect(byField.get("current")!.profileVersion).toBe(1);
  });

  it("a recorded ZERO round-trips as a value, not an absence", async () => {
    // The payload sends the number as a STRING precisely so a zero survives.
    const studio = await seedStudio("e2e-zero");
    const { blockId } = await seedSession(studio);
    const id = await registerSynthetic(studio, "Room 1");
    await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: [
          {
            stageKey: null,
            fieldKey: "current",
            value: { kind: "value", value: 0 },
            nativeUnit: "µA",
            decimals: 0,
            observationSource: "practitioner-entered",
          },
        ],
      }),
    );
    const back = await asDb(studio.userId, (db) => readingsForBlock(db, blockId));
    expect(back.ok && back.value[0]!.value).toEqual({ kind: "value", value: 0 });
  });

  it("an absence round-trips with its reason", async () => {
    const studio = await seedStudio("e2e-absent");
    const { blockId } = await seedSession(studio);
    const id = await registerSynthetic(studio, "Room 1");
    await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: [
          {
            stageKey: null,
            fieldKey: "duration",
            value: { kind: "absent", reason: "not-legible" },
            nativeUnit: "s",
            decimals: 0,
            observationSource: "practitioner-entered",
          },
        ],
      }),
    );
    const back = await asDb(studio.userId, (db) => readingsForBlock(db, blockId));
    expect(back.ok && back.value[0]!.value).toEqual({
      kind: "absent",
      reason: "not-legible",
    });
  });

  it("two probe groups both persist", async () => {
    const studio = await seedStudio("e2e-groups");
    const { blockId } = await seedSession(studio);
    const id = await registerSynthetic(studio, "Room 1");
    for (const [group, channels, current] of [
      ["g1", [1, 2], 120],
      ["g2", [3], 90],
    ] as const) {
      await asDb(studio.userId, (db) =>
        recordSetupGroup(db, {
          blockId,
          machineId: id,
          modeKey: "galvanic",
          groupKey: group,
          channels: [...channels],
          readings: [
            {
              stageKey: null,
              fieldKey: "current",
              value: { kind: "value", value: current },
              nativeUnit: "µA",
              decimals: 0,
              observationSource: "practitioner-entered",
            },
          ],
        }),
      );
    }
    const back = await asDb(studio.userId, (db) => readingsForBlock(db, blockId));
    expect(back.ok && back.value).toHaveLength(2);
    if (back.ok) {
      expect(back.value.map((r) => r.groupKey).sort()).toEqual(["g1", "g2"]);
    }
  });

  it("another studio cannot read them", async () => {
    const mine = await seedStudio("e2e-read-a");
    const other = await seedStudio("e2e-read-b");
    const { blockId } = await seedSession(mine);
    const id = await registerSynthetic(mine, "Room 1");
    await asDb(mine.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: READINGS,
      }),
    );
    const seen = await asDb(other.userId, (db) => readingsForBlock(db, blockId));
    expect(seen.ok && seen.value).toEqual([]);
  });
});

describe("MPX-03 · NEXT-VISIT retrieval returns one coherent prior setup", () => {
  it("returns the most recent block's whole group, not a mixture of visits", async () => {
    const studio = await seedStudio("e2e-next");
    const id = await registerSynthetic(studio, "Room 1");

    const first = await seedSession(studio);
    await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId: first.blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: [
          {
            stageKey: null,
            fieldKey: "current",
            value: { kind: "value", value: 80 },
            nativeUnit: "µA",
            decimals: 0,
            observationSource: "practitioner-entered",
          },
        ],
      }),
    );

    const second = await seedSession(studio);
    await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId: second.blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: READINGS,
      }),
    );

    const prior = await asDb(studio.userId, (db) =>
      latestRecordedSetup(db, studio.studioId),
    );
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;

    // ONE block, both its fields — a current without its duration is not a
    // setting anyone can repeat.
    expect(new Set(prior.value.map((r) => r.blockId)).size).toBe(1);
    expect(prior.value[0]!.blockId).toBe(second.blockId);
    expect(prior.value.map((r) => r.fieldKey).sort()).toEqual([
      "current",
      "duration",
    ]);

    // The earlier visit is untouched.
    const firstStill = await adminQuery(
      `select value_numeric::text as v from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [first.blockId],
    );
    expect(firstStill.rows[0].v).toBe("80");
  });

  it("renders into the next-visit view the panel shows, with units and provenance", async () => {
    // The retrieval payload feeds `priorSetupView`, which is what the mounted
    // panel renders. Proving the two fit together is the point: a payload the
    // renderer cannot use is not a retrieval.
    const studio = await seedStudio("e2e-next-view");
    const id = await registerSynthetic(studio, "Room 1");
    const { blockId } = await seedSession(studio);
    await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: id,
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [2],
        readings: READINGS,
      }),
    );

    const prior = await asDb(studio.userId, (db) =>
      latestRecordedSetup(db, studio.studioId),
    );
    if (!prior.ok) throw new Error("expected a prior setup");

    const view = priorSetupView(
      {
        profileId: prior.value[0]!.profileId,
        profileVersion: prior.value[0]!.profileVersion,
        modeKey: prior.value[0]!.modeKey,
        recordedAt: prior.value[0]!.recordedAt,
        sessionId: prior.value[0]!.blockId,
        groups: [
          {
            groupId: prior.value[0]!.groupKey,
            channels: prior.value[0]!.channels,
            readings: Object.fromEntries(
              prior.value.map((r) => [r.fieldKey, r.value]),
            ),
          },
        ],
      },
      CAT,
    );
    expect("unavailable" in view).toBe(false);
    if ("unavailable" in view) return;

    expect(view.machine).toBe("Synthetic E2E Demo");
    expect(view.modeLabel).toBe("Galvanic");
    expect(view.renderedAgainstHistoricalVersion).toBe(false);
    expect(view.groups[0]!.channels).toEqual([2]);
    const rows = new Map(view.groups[0]!.rows.map((r) => [r.key, r]));
    expect(rows.get("current")!.unit).toBe("µA");
    expect(rows.get("current")!.display).toBe("120");
    expect(rows.get("duration")!.display).toBe("300.5");
  });

  it("and the chart shows that model's native fields for entry", async () => {
    // The other half of the mounted path: the entry surface is derived from the
    // same profile the retrieval names.
    const groups = nativeFieldGroups(SYNTH, SYNTH.modes[0]!);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.fields.map((f) => [f.label, f.unit])).toEqual([
      ["Current", "µA"],
      ["Time", "s"],
    ]);
  });

  it("a studio with no history gets an empty prior setup, not an error", async () => {
    const studio = await seedStudio("e2e-next-none");
    const prior = await asDb(studio.userId, (db) =>
      latestRecordedSetup(db, studio.studioId),
    );
    expect(prior.ok && prior.value).toEqual([]);
  });
});

describe("MPX-03 · the adapter itself is not lying", () => {
  it("surfaces a database refusal as an error, never as empty data", async () => {
    // If the adapter swallowed errors into `data: []`, half the refusal tests
    // above would pass for the wrong reason. A bad machine id must surface.
    const studio = await seedStudio("e2e-adapter");
    const { blockId } = await seedSession(studio);
    const out = await asDb(studio.userId, (db) =>
      recordSetupGroup(db, {
        blockId,
        machineId: "00000000-0000-0000-0000-000000000000",
        modeKey: "galvanic",
        groupKey: "g1",
        channels: [],
        readings: READINGS,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unknown machine/i);
  });

  it("a persistence failure reaches the store as PersistenceUnavailableError", async () => {
    const studio = await seedStudio("e2e-adapter-store");
    await expect(
      asDb(studio.userId, (db) =>
        createDatabaseStore(db, () => "not-a-uuid").read({
          studioId: studio.studioId,
          practitionerId: "not-a-uuid",
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceUnavailableError);
  });
});
