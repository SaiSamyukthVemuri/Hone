import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// A SETTINGS SAVE IS NOT CONFIRMED WITHOUT ITS RECEIPT (Codex, #860 4309128376)
// ===========================================================================
//
// THE DEFECT. `createTreatmentAreaWithEntryAction` returned SUCCESS as soon as
// a `block_id` came back, whatever `setup` held. The form treats `ok: true` as
// the save closing: it clears the retry key, unfreezes, and dismisses. So a
// response carrying a block but a missing or malformed setup receipt discarded
// every entered setting SILENTLY - nothing on screen to retry, and no
// confirmation that the submission exists.
//
// WHY NULL IS ANOMALOUS ON THIS PATH, verified in 0223 rather than assumed.
// The fresh path builds the receipt only when the groups array is non-empty,
// which is exactly when `withSetup` is true. The one place 0223 yields a null
// receipt is an ABSORBED RETRY whose original claim has `submission_id is
// null` - the original recorded no settings - and a retry that carried
// settings would have a different payload digest and be refused outright. So a
// same-digest retry cannot produce a null receipt for a save that had
// settings.
//
// WHY UNRESOLVED AND NOT A FAILURE. The block id came back, so the area and
// possibly the settings may be committed. A definitive failure would unfreeze
// the draft and drop the retry key, and a later save would append a SECOND
// area with a second copy of the settings. Same law as 4308887493: only an
// authoritative answer for the same key may settle the question.
//
// DRIVEN THROUGH THE ACTION, not through its predicate. The predicate alone
// would prove a string check; what matters is the OUTCOME the form receives,
// because `unresolved` is what keeps the draft and the key.
//
// Synthetic ids only. Nothing here corresponds to anything real.

const rpc = vi.fn();
const single = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => rpc(name, args),
    from: () => ({
      select: () => ({
        eq: () => ({ single: () => single() }),
      }),
    }),
  }),
}));

vi.mock("@/lib/supabase/writing-identity", () => ({
  resolveWritingIdentity: async () => ({
    ok: true,
    value: {
      practitioner: { id: "prac-1", active: true },
      studio: { id: "studio-1" },
    },
  }),
}));

vi.mock("@/lib/sessions/session-lineage", () => ({
  assertSessionForClient: async () => {},
  SessionLineageError: class SessionLineageError extends Error {},
}));

vi.mock("@/lib/machines/studio-devices", () => ({
  listStudioDevices: async () => ({
    devices: [
      {
        deviceId: "dev-1",
        studioId: "studio-1",
        profileId: "fixture:receipt",
        profileVersion: 1,
        displayName: "Room 1",
        installedOptions: [],
        retiredAt: null,
      },
    ],
  }),
}));

// A FIXTURE CATALOGUE, AND THE GATE IS LEFT ALONE.
//
// The first version of this test reached for the synthetic profile and stubbed
// `HONE_SYNTHETIC_MACHINE_PROFILE=1`. That is not enough and should not be
// made enough: `syntheticProfileEnabled` requires THREE conditions - no
// deployed-environment signal, a local Supabase URL, and the exact flag - and
// stubbing all three in a unit test is defeating a deliberate safety gate
// rather than using it. Every REAL catalogue profile is blocked or
// legacy-only, so a fixture built on one would be refused by the validator for
// an unrelated reason and this test would pass for the wrong cause.
//
// So the catalogue is injected the same way `validate-submitted-readings.test.ts`
// does it, and the VALIDATOR stays real - the point of this test is the
// response handling, and stubbing validation would let a change there pass
// unnoticed here.
const FIELD_KEY = "current";
const MODE_KEY = "m";

const FIXTURE_PROFILE = {
  profileId: "fixture:receipt",
  version: 1,
  family: "Dectro/Apilus",
  manufacturer: "Fixture",
  model: "Receipt",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [
    {
      id: "fx",
      kind: "studio-device-photo",
      consultedOn: "2026-10-18",
      establishes: "Nothing about a real machine.",
    },
  ],
  openQuestions: [],
  modes: [
    {
      key: MODE_KEY,
      nativeLabel: "M",
      family: "thermolysis",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["fx"],
      stages: [],
      fields: [
        {
          key: FIELD_KEY,
          nativeLabel: "Current",
          quantity: "current",
          unit: "mA",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["fx"],
        },
      ],
    },
  ],
};

vi.mock("@/lib/machines/synthetic-profile", () => ({
  catalogueForRuntime: () => [FIXTURE_PROFILE],
}));

const { createTreatmentAreaWithEntryAction } = await import(
  "@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions"
);
const { INITIAL_SAVE_UNRESOLVED } = await import(
  "@/lib/machines/pending-setup"
);

const BLOCK_ROW = {
  id: "block-1",
  session_id: "session-1",
  updated_at: "2026-10-18T10:00:00Z",
};

const input = {
  clientId: "client-1",
  sessionId: "session-1",
  initialSetup: {
    machineId: "dev-1",
    modeKey: MODE_KEY,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    groups: [
      {
        groupKey: null,
        newGroupRef: "g1",
        channels: [] as number[],
        readings: [
          {
            stageKey: null,
            fieldKey: FIELD_KEY,
            value: { kind: "value" as const, value: 1 },
            observationSource: "practitioner-entered" as const,
          },
        ],
      },
    ],
  },
};

const withReceipt = (setup: unknown) => {
  rpc.mockResolvedValue({ data: { block_id: "block-1", setup }, error: null });
  single.mockResolvedValue({ data: BLOCK_ROW, error: null });
  return createTreatmentAreaWithEntryAction(input);
};

beforeEach(() => {
  rpc.mockReset();
  single.mockReset();
});

describe("ANTI-VACUITY: the harness really reaches the response handling", () => {
  it("a VALID receipt is reported as success, so the fixture is not failing early", () => {
    // Without this, every unresolved assertion below could be the action
    // refusing for an unrelated reason - a bad fixture, a validation error, a
    // missing device - and would look exactly like the defect being caught.
    return withReceipt({
      submission_id: "22222222-2222-4222-8222-222222222222",
      groups: 1,
      readings: 1,
      reused: false,
    }).then((out) => {
      expect(out.ok, out.ok ? "" : out.error).toBe(true);
      expect(rpc).toHaveBeenCalledWith(
        "create_block_with_initial_setup_and_identity",
        expect.anything(),
      );
    });
  });
});

describe("a block without a usable setup receipt is UNRESOLVED", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a submission_id of null", { submission_id: null }],
    ["a blank submission_id", { submission_id: "   " }],
    ["a non-string submission_id", { submission_id: 7 }],
    ["a string instead of an object", "ok"],
    ["counts but no id", { groups: 1, readings: 3, reused: false }],
  ];

  for (const [label, setup] of cases) {
    it(`${label} is unresolved, not success`, async () => {
      const out = await withReceipt(setup);
      expect(
        out.ok,
        `a response with ${label} for a setup receipt was reported as SUCCESS, so the form closes and the draft is discarded`,
      ).toBe(false);
      if (out.ok) return;
      expect(
        "unresolved" in out && out.unresolved,
        `${label} was reported as a DEFINITIVE failure, so the draft unfreezes and the retry key is dropped - a later save then appends a second area`,
      ).toBe(true);
      expect(out.error).toBe(INITIAL_SAVE_UNRESOLVED);
    });
  }
});

describe("and the message is the one the form holds the draft on", () => {
  it("it is the shared unresolved sentence, not a new string", () => {
    // The form decides to freeze from `unresolved`, and shows this sentence.
    // A bespoke message here would read as a different event to the
    // practitioner for what is the same one.
    return withReceipt(null).then((out) => {
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe(INITIAL_SAVE_UNRESOLVED);
    });
  });
});

it("initial save preserves exact text in the governed atomic payload", async () => {
  const field = FIXTURE_PROFILE.modes[0].fields[0];
  const before = structuredClone(field);
  try {
    Object.assign(field, { quantity: "preset-identifier", unit: "none", decimals: 0, valueKind: "text" });
    rpc.mockResolvedValue({ data: { block_id: "block-1", setup: { submission_id: "22222222-2222-4222-8222-222222222222", groups: 1, readings: 1, reused: false } }, error: null });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const textInput = structuredClone(input) as Parameters<typeof createTreatmentAreaWithEntryAction>[0];
    textInput.initialSetup!.groups[0].readings[0].value = { kind: "text", value: "003i" };
    const out = await createTreatmentAreaWithEntryAction(textInput);
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(rpc).toHaveBeenCalledWith("create_block_with_initial_setup_and_identity", expect.objectContaining({ p_setup_groups: [expect.objectContaining({ readings: [expect.objectContaining({ value_text: "003i", native_unit: "none", decimals: 0 })] })] }));
  } finally {
    Object.assign(field, before);
    delete (field as typeof field & { valueKind?: string }).valueKind;
  }
});

// ===========================================================================
// MIGRATION-FIRST ORDER CAN SLIP (0301; Privacy EH-1/EH-2)
// ===========================================================================
//
// The app now calls an identity-recording wrapper that exists only after 0301.
// If the database does not have it (PGRST202 / 42883) NOTHING ran, so:
//   * a save WITH settings goes to the 0223 command, as before, minus the
//     identity argument, and the settings are recorded;
//   * a save that carries ONLY a machine choice is refused with a visible
//     "can't save the machine choice yet" and writes nothing: never "saved".
// Both directions are driven through the action, and the negative controls
// show an ordinary refusal does NOT fall back.
describe("0301 not applied yet: the app degrades safely", () => {
  const GOOD = {
    block_id: "block-1",
    setup: { submission_id: "22222222-2222-4222-8222-222222222222", groups: 1, readings: 1, reused: false },
  };
  const missing = { code: "PGRST202", message: "Could not find the function" };

  it("a settings save falls back to create_block_with_initial_setup, without the identity argument", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "create_block_with_initial_setup_and_identity"
        ? { data: null, error: missing }
        : { data: GOOD, error: null },
    );
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction(input);
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "create_block_with_initial_setup_and_identity",
      "create_block_with_initial_setup",
    ]);
    const fallbackArgs = rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(fallbackArgs).not.toHaveProperty("p_machine_profile_id");
    expect(fallbackArgs).toHaveProperty("p_setup_groups");
    expect(fallbackArgs.p_setup_idempotency_key).toBe(input.initialSetup.idempotencyKey);
  });

  // Insurance LB-1b: a keyed BARE create (no settings) takes the same fallback with its retry key and empty groups intact.
  it("a keyed bare create falls back to create_block_with_initial_setup carrying p_setup_idempotency_key and no groups", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "create_block_with_initial_setup_and_identity"
        ? { data: null, error: missing }
        : { data: { block_id: "block-1" }, error: null },
    );
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    await createTreatmentAreaWithEntryAction({ clientId: "client-1", sessionId: "session-1", createKey: "bare-retry-key-0001" });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      "create_block_with_initial_setup_and_identity",
      "create_block_with_initial_setup",
    ]);
    const fallbackArgs = rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(fallbackArgs).not.toHaveProperty("p_machine_profile_id");
    expect(fallbackArgs.p_setup_idempotency_key).toBe("bare-retry-key-0001");
    expect(fallbackArgs.p_setup_groups).toEqual([]);
  });

  it("42883 (undefined_function) falls back the same way", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "create_block_with_initial_setup_and_identity"
        ? { data: null, error: { code: "42883", message: "function does not exist" } }
        : { data: GOOD, error: null },
    );
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction(input);
    expect(out.ok).toBe(true);
  });

  it("an identity-only save is REFUSED with a visible message and writes nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: missing });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction({
      clientId: "client-1",
      sessionId: "session-1",
      machineIdentity: { machineId: "dev-1", modeKey: MODE_KEY, profileId: null },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/can't save the machine choice yet/i);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["create_block_with_initial_setup_and_identity"]);
  });

  // Codex, #1369 4498767101: the identity command only checks the unit is this studio's and not retired, so the action applies
  // the remembered-choice contract first. A refusal here has sent nothing.
  it("an identity-only save with a mode the unit's model does not offer is REFUSED before any command, with clear copy", async () => {
    rpc.mockResolvedValue({ data: GOOD, error: null });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction({
      clientId: "client-1",
      sessionId: "session-1",
      machineIdentity: { machineId: "dev-1", modeKey: "not-a-mode", profileId: null },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/does not offer that mode/i);
    expect(out.error).toMatch(/nothing was saved/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an identity-only save naming a unit this studio does not have is REFUSED before any command", async () => {
    rpc.mockResolvedValue({ data: GOOD, error: null });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction({
      clientId: "client-1",
      sessionId: "session-1",
      machineIdentity: { machineId: "dev-other", modeKey: MODE_KEY, profileId: null },
    });
    expect(out.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("CONTROL: the supported unit and mode is sent to the identity command", async () => {
    rpc.mockResolvedValue({ data: GOOD, error: null });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction({
      clientId: "client-1",
      sessionId: "session-1",
      machineIdentity: { machineId: "dev-1", modeKey: MODE_KEY, profileId: null },
    });
    expect(out.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "create_block_with_initial_setup_and_identity",
      expect.objectContaining({ p_studio_machine_id: "dev-1", p_setup_mode_key: MODE_KEY }),
    );
  });

  it("NEGATIVE CONTROL: an ordinary refusal does NOT fall back to the older command", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "check violation" } });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction(input);
    expect(out.ok).toBe(false);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["create_block_with_initial_setup_and_identity"]);
  });

  it("WITH 0301 present nothing changes: one call, the identity wrapper", async () => {
    rpc.mockResolvedValue({ data: GOOD, error: null });
    single.mockResolvedValue({ data: BLOCK_ROW, error: null });
    const out = await createTreatmentAreaWithEntryAction(input);
    expect(out.ok).toBe(true);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["create_block_with_initial_setup_and_identity"]);
  });
});
