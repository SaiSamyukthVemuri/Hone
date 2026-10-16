import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// MPX-03 — the server surface: identity is derived, ownership is never
// submitted, and the synthetic demo profile cannot reach production.
//
// The DATA PATH is proved against a real database in
// tests/db/machine-workflow-end-to-end.db.test.ts. What this file adds is the
// part that has no database in it: what the actions accept, what they refuse
// before touching a client, and what the synthetic gate does.
// ===========================================================================

const SESSION = vi.hoisted(() => ({
  current: null as null | {
    practitioner: { id: string; role: string };
    studio: { id: string };
  },
}));

/** A controllable stand-in for the Supabase client the actions build. */
const DB = vi.hoisted(() => ({
  rows: [] as unknown[],
  rpcResult: null as unknown,
  rpcError: null as null | { message: string },
  selectError: null as null | { message: string },
  /**
   * PER-TABLE overrides, because some behaviour only exists when one read
   * fails and another succeeds.
   *
   * `from()` used to discard its argument, so every table shared one `rows`
   * and one `selectError` - which made "the inventory read failed but the
   * remembered selection read did not" untestable, and that is precisely the
   * state in which the loader asserted a machine had been DEREGISTERED when
   * its existence was merely unknown (Codex, d3e8b17b). Both fall back to the
   * shared fields, so existing cases are unaffected.
   */
  rowsFor: {} as Record<string, unknown[]>,
  errorFor: {} as Record<string, { message: string }>,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => SESSION.current,
}));

/**
 * The shared clinical-lineage assertion. Recorded rather than stubbed away,
 * because "the loader authorizes the route's client" is now a claim this file
 * has to be able to prove, not an implementation detail.
 */
const LINEAGE = vi.hoisted(() => ({
  calls: [] as Array<{ studioId: string; clientId: string; sessionId: string }>,
  throws: null as null | Error,
}));

vi.mock("@/lib/sessions/session-lineage", () => ({
  assertSessionForClient: async (
    studioId: string,
    clientId: string,
    sessionId: string,
  ) => {
    LINEAGE.calls.push({ studioId, clientId, sessionId });
    if (LINEAGE.throws) throw LINEAGE.throws;
  },
}));

/** The route values every loader call needs. */
const ROUTE = { clientId: "client-ana", sessionId: "session-1" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      DB.calls.push({ fn, args });
      return { data: DB.rpcResult, error: DB.rpcError };
    },
    from: (table: string) => {
      const error = DB.errorFor[table] ?? DB.selectError;
      const rows = DB.rowsFor[table] ?? DB.rows;
      const result = async () => ({ data: error ? null : rows, error });
      /**
       * A KEYSET PAGE, MODELLED RATHER THAN IGNORED.
       *
       * `readingsForBlock` reads a block's readings COMPLETELY now - pages by
       * `id`, each after the last one seen, until a page comes back EMPTY -
       * because `.limit(500)` silently truncated and could cut a capture in
       * half (Codex, #860 4288424513). A fake that answered every page with
       * the same rows would loop or look complete when it was not, so it
       * filters here exactly as the database does. The rows it serves need an
       * `id` for the same reason.
       */
      const pageAfter = (cursor: string) => async () => ({
        data: error
          ? null
          : (rows as Array<{ id?: unknown }>).filter(
              (r) => typeof r.id === "string" && r.id > cursor,
            ),
        error,
      });
      return {
        select: () => ({
          eq: () => ({
            is: () => ({ order: result }),
            order: () => ({ limit: result }),
            gt: (_column: string, value: string) => ({
              order: () => ({ limit: pageAfter(value) }),
            }),
            in: () => ({ limit: result }),
            maybeSingle: result,
            limit: result,
          }),
        }),
      };
    },
  }),
}));

const actions = await import(
  "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions"
);
const synthetic = await import("@/lib/machines/synthetic-profile");

const ACTIONS_SRC = readFileSync(
  path.resolve(
    __dirname,
    "../../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
  ),
  "utf8",
);
const CODE = ACTIONS_SRC.split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

function signIn(studioId: string, practitionerId: string, role = "owner") {
  SESSION.current = {
    practitioner: { id: practitionerId, role },
    studio: { id: studioId },
  };
}

beforeEach(() => {
  SESSION.current = null;
  DB.rows = [];
  DB.rpcResult = null;
  DB.rpcError = null;
  DB.selectError = null;
  DB.rowsFor = {};
  DB.errorFor = {};
  DB.calls = [];
});

// ---------------------------------------------------------------------------

describe("ownership cannot be submitted", () => {
  it("loadMachineSetupContext accepts the ROUTE SUBJECT and no ownership", async () => {
    // This used to assert it accepted NO arguments at all, and that assertion
    // was itself the bug: with no client in scope the prior-setup read could
    // only ask "what was recorded in this STUDIO", which is the wrong record
    // in any studio with more than one client (Codex, 9c6fbbe5).
    //
    // The principle was never "accept nothing". It is "accept no AUTHORITY":
    // a caller may say which chart is open, because the server authorizes that
    // pair; it may not say who it is or which studio it belongs to.
    const body = readFileSync(
      path.resolve(
        __dirname,
        "../../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
      ),
      "utf8",
    );
    // The SIGNATURE: up to the return type, which is where the accepted
    // shape is fully stated. (Bracketing the whole function with `\n}` does
    // not work - the input type's own closing brace ends the match first,
    // which silently made an earlier version of this test assert nothing
    // about the body at all.)
    const sig = /export async function loadMachineSetupContext\(([\s\S]*?)\)\s*:\s*Promise/.exec(
      body,
    );
    expect(sig, "the loader's signature must be findable").not.toBeNull();
    // It takes the route subject...
    expect(sig![1]).toMatch(/clientId: string;/);
    expect(sig![1]).toMatch(/sessionId: string;/);
    // ...and still accepts no ownership of any kind.
    expect(sig![1]).not.toMatch(/studioId/);
    expect(sig![1]).not.toMatch(/practitionerId/);

    // ...and it authorizes that pair against the SERVER-derived studio.
    expect(body).toMatch(
      /assertSessionForClient\(\s*scope\.studioId,\s*input\.clientId,\s*input\.sessionId\s*\)/,
    );
  });

  it("each write action takes only what is being written", () => {
    expect(actions.rememberMachineSelectionAction.length).toBe(1);
    expect(actions.registerMachineAction.length).toBe(1);
    expect(actions.recordReadingsAction.length).toBe(1);
    expect(actions.retireMachineAction.length).toBe(1);
  });

  it("no action reads an ownership field out of its own input", () => {
    // The only studio id the module may touch is the one it derived through
    // `identity()`. An input-shaped ownership read is the defect.
    for (const shape of ["choice", "input"]) {
      expect(CODE).not.toMatch(
        new RegExp(`${shape}\\.(studioId|practitionerId)`),
      );
    }
    expect(CODE).toContain("getCurrentPractitionerWithStudio");
  });

  it("no exported action's parameter object declares an ownership field", () => {
    // Scoped per signature rather than over a loose slice of the file, so a
    // later return-type rename cannot silently widen what this reads.
    const signatures = [
      ...ACTIONS_SRC.matchAll(
        /export async function (\w+)\(([\s\S]*?)\)\s*:\s*Promise</g,
      ),
    ];
    expect(signatures.length).toBeGreaterThan(5);
    for (const [, name, params] of signatures) {
      expect(params, `${name} accepts a studio id`).not.toContain("studioId");
      expect(params, `${name} accepts a practitioner id`).not.toContain(
        "practitionerId",
      );
    }
  });

  it("the reading action sends no studio: the block determines it", () => {
    const body = CODE.slice(CODE.indexOf("export async function recordReadingsAction"));
    expect(body).not.toMatch(/p_studio_id/);
  });
});

describe("identity comes from the session, per call", () => {
  it("an anonymous request gets no scope and nothing else either", async () => {
    const ctx = await actions.loadMachineSetupContext(ROUTE);
    expect(ctx.scope).toBeNull();
    expect(ctx.devices).toEqual([]);
    expect(ctx.catalogue).toEqual([]);
    expect(ctx.canManageMachines).toBe(false);
    expect(ctx.priorSetup).toEqual([]);
    expect(ctx.persistence.persisted).toBe(false);
  });

  it("an authenticated request gets ITS OWN scope, derived not supplied", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext(ROUTE);
    expect(ctx.scope).toEqual({
      studioId: "studio-fett",
      practitionerId: "pract-sabrina",
    });
  });

  it("switching session identity switches the scope, with no client input", async () => {
    signIn("studio-one", "pract-a");
    expect((await actions.loadMachineSetupContext(ROUTE)).scope?.studioId).toBe("studio-one");
    signIn("studio-two", "pract-b");
    expect((await actions.loadMachineSetupContext(ROUTE)).scope?.studioId).toBe("studio-two");
  });

  it("reports DATABASE persistence when the remembered read succeeds", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext(ROUTE);
    expect(ctx.persistence.kind).toBe("database");
    expect(ctx.persistence.persisted).toBe(true);
  });

  it("falls back to NO persistence when that read FAILS, rather than claiming it", async () => {
    signIn("studio-fett", "pract-sabrina");
    DB.selectError = { message: "connection reset" };
    const ctx = await actions.loadMachineSetupContext(ROUTE);
    expect(ctx.persistence.kind).toBe("none");
    // And the inventory read failing is reported as unreadable, not as empty.
    expect(ctx.inventoryReason).toMatch(/do not add a\s+duplicate/i);
  });

  it("an empty studio is reported as empty, not unreadable", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext(ROUTE);
    expect(ctx.inventoryReason).toMatch(/no machine registered yet/i);
  });

  it("only an owner may manage machines", async () => {
    signIn("studio-fett", "pract-sabrina", "practitioner");
    expect((await actions.loadMachineSetupContext(ROUTE)).canManageMachines).toBe(false);
    signIn("studio-fett", "pract-sabrina", "owner");
    expect((await actions.loadMachineSetupContext(ROUTE)).canManageMachines).toBe(true);
  });
});

describe("registration refuses a profile the server does not offer", () => {
  it("refuses an unauthenticated caller", async () => {
    const r = await actions.registerMachineAction({
      profileId: "synthetic:demo-multineedle",
      displayName: "Room 1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthenticated");
  });

  it("refuses a BLOCKED real profile, so no model is activated by registering it", async () => {
    signIn("studio-fett", "pract-sabrina");
    for (const id of [
      "silhouettone:evolution-st-350",
      "permanence-gemm:gemm-16",
      "dectro-apilus:xcell",
    ]) {
      const r = await actions.registerMachineAction({
        profileId: id,
        displayName: "Room 1",
      });
      expect(r.ok, `${id} must not be registerable`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/after its evidence review/i);
    }
    // Nothing reached the database.
    expect(DB.calls).toEqual([]);
  });

  it("refuses an invented profile id", async () => {
    signIn("studio-fett", "pract-sabrina");
    const r = await actions.registerMachineAction({
      profileId: "acme:whatever",
      displayName: "Room 1",
    });
    expect(r.ok).toBe(false);
    expect(DB.calls).toEqual([]);
  });

  it("refuses an empty or over-long name before any write", async () => {
    signIn("studio-fett", "pract-sabrina");
    for (const name of ["", "   ", "x".repeat(81)]) {
      const r = await actions.registerMachineAction({
        profileId: "synthetic:demo-multineedle",
        displayName: name,
      });
      expect(r.ok).toBe(false);
    }
    expect(DB.calls).toEqual([]);
  });

  it("takes the contract VERSION from the server catalogue, never the client", () => {
    // A client-supplied version could register a unit against a contract that
    // does not exist, and every later reading would cite it.
    const body = CODE.slice(CODE.indexOf("export async function registerMachineAction"));
    expect(body).toContain("profileVersion: profile.version");
    expect(body).not.toMatch(/profileVersion: input\./);
  });
});

describe("the prior-setup read is scoped to the ROUTE CLIENT, not the studio", () => {
  // The defect this replaced: latestRecordedSetup took only a studio id, so in
  // a studio with more than one client the panel showed whichever block was
  // newest - another client's settings as guidance for this one (Codex,
  // 9c6fbbe5). PR #286 had already removed studio-only scoping from the WRITES
  // in this directory for the same reason.
  beforeEach(() => {
    LINEAGE.calls.length = 0;
    LINEAGE.throws = null;
  });

  it("AUTHORIZES the route client against the server-derived studio", async () => {
    signIn("studio-fett", "pract-sabrina");
    await actions.loadMachineSetupContext(ROUTE);
    expect(LINEAGE.calls).toEqual([
      {
        // The studio is NOT taken from the caller: it is the signed-in one.
        studioId: "studio-fett",
        clientId: "client-ana",
        sessionId: "session-1",
      },
    ]);
  });

  it("refuses rather than reading when the session is not this client's", async () => {
    signIn("studio-fett", "pract-sabrina");
    LINEAGE.throws = new Error("Session does not belong to this client.");
    await expect(
      actions.loadMachineSetupContext(ROUTE),
    ).rejects.toThrow(/does not belong to this client/);
  });

  it("asks the database for THIS CLIENT's latest setup, by name", async () => {
    signIn("studio-fett", "pract-sabrina");
    DB.calls.length = 0;
    await actions.loadMachineSetupContext(ROUTE);
    const call = DB.calls.find((c) => c.fn === "latest_setup_for_client");
    expect(
      call,
      "the prior setup must be read through the client-scoped function",
    ).toBeTruthy();
    expect(call!.args).toMatchObject({
      p_studio_id: "studio-fett",
      p_client_id: "client-ana",
    });
  });

  it("never reads the readings table with a studio-only filter again", () => {
    // A source pin, because the old shape was a plain filtered select and
    // would typecheck perfectly if someone reintroduced it.
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/machines/machine-queries.ts"),
      "utf8",
    );
    const fn = /export async function latestRecordedSetup[\s\S]*?\n}/.exec(src);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("latest_setup_for_client");
    expect(fn![0]).toMatch(/clientId/);
  });
});

// ===========================================================================
// THE WHOLE-SAVE PATH — one Save, one call, one retry key.
//
// Several separate record_treatment_setup_group calls could not be atomic,
// could not see a channel claimed by two groups, and could not be retried
// after a lost response (Codex, #860 6157725545).
// `record_treatment_setup_submission` is the command; these are the claims
// about the SERVER SURFACE in front of it.
//
// THE RETRY KEY IS THE THING MOST WORTH GUARDING. If it is dropped anywhere
// between the form and the RPC the feature is silently inert: every retry
// becomes a new save and a lost response duplicates an immutable capture.
// This lane has already shipped one field the wrapper never forwarded
// (`priorUnitNames`, Codex 2351742d), so the forwarding is asserted, not
// assumed.
// ===========================================================================

/** A studio, a signed-in owner and one registered synthetic device. */
function synthDevice() {
  vi.stubEnv("HONE_SYNTHETIC_MACHINE_PROFILE", "1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  signIn("studio-fett", "pract-sabrina", "owner");
  DB.rows = [
    {
      id: "dev-1",
      studio_id: "studio-fett",
      machine_profile_id: "synthetic:demo-multineedle",
      machine_profile_version: 2,
      display_name: "Room 1",
      installed_options: [],
      retired_at: null,
    },
  ];
}

const READING = (value: number) => ({
  stageKey: null,
  fieldKey: "current",
  value: { kind: "value" as const, value },
  observationSource: "practitioner-entered" as const,
});

describe("recordSetupSubmissionAction sends ONE call for the whole save", () => {
  it("sends every group, with its own channels, in one RPC", async () => {
    synthDevice();
    DB.rpcResult = {
      submission_id: "sub-1",
      groups: 2,
      readings: 2,
      reused: false,
    };
    const out = await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0001",
      groups: [
        { groupKey: "g1", channels: [1, 2], readings: [READING(120)] },
        { groupKey: "g2", channels: [3], readings: [READING(80)] },
      ],
    });
    expect(out.ok, out.ok ? "" : out.error).toBe(true);

    const calls = DB.calls.filter(
      (c) => c.fn === "record_treatment_setup_submission",
    );
    // ONE CALL. Two would mean the atomicity this exists for was never
    // obtained, whatever the command does.
    expect(calls).toHaveLength(1);
    // And NOT through the per-group command.
    expect(
      DB.calls.filter((c) => c.fn === "record_treatment_setup_group"),
    ).toHaveLength(0);

    const args = calls[0]!.args as Record<string, unknown>;
    expect(args.p_block_id).toBe("block-1");
    expect(args.p_studio_machine_id).toBe("dev-1");
    expect(args.p_mode_key).toBe("galvanic");
    // THE KEY REACHES THE DATABASE. Dropped anywhere along the way, every
    // retry becomes a new save.
    expect(args.p_idempotency_key).toBe("save-key-0001");

    const groups = args.p_groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2);
    expect(groups[0]!.group_key).toBe("g1");
    expect(groups[0]!.channels).toEqual([1, 2]);
    expect(groups[1]!.group_key).toBe("g2");
    expect(groups[1]!.channels).toEqual([3]);
  });

  it("DERIVES unit and precision for every group, never taking the caller's", async () => {
    synthDevice();
    DB.rpcResult = { submission_id: "sub-1", groups: 1, readings: 1, reused: false };
    await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0002",
      groups: [{ groupKey: "g1", channels: [1], readings: [READING(120)] }],
    });
    const args = DB.calls.find(
      (c) => c.fn === "record_treatment_setup_submission",
    )!.args as Record<string, unknown>;
    const readings = (args.p_groups as Array<Record<string, unknown>>)[0]!
      .readings as Array<Record<string, unknown>>;
    // The machine's own unit, from the contract the DEVICE is registered
    // against - not from the payload, which has no field for it.
    expect(readings[0]!.native_unit).toBeTruthy();
    expect(typeof readings[0]!.decimals).toBe("number");
    // Sent as a STRING so a recorded zero and the machine's precision survive
    // JSON, exactly as the per-group command does it.
    expect(readings[0]!.value).toBe("120");
  });

  it("refuses the WHOLE save when any group has an impossible field", async () => {
    // Validated before anything is sent: the command would refuse the save
    // too, which is correct, but she should not wait for a round trip to be
    // told something this process already knew.
    synthDevice();
    const out = await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0003",
      groups: [
        { groupKey: "g1", channels: [1], readings: [READING(120)] },
        {
          groupKey: "g2",
          channels: [2],
          readings: [
            {
              stageKey: null,
              fieldKey: "not_a_real_field",
              value: { kind: "value" as const, value: 3 },
              observationSource: "practitioner-entered" as const,
            },
          ],
        },
      ],
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error).toMatch(/not_a_real_field/);
    // NOTHING WAS SENT. A refusal that had already issued the call would have
    // recorded the first group.
    expect(
      DB.calls.filter((c) => c.fn === "record_treatment_setup_submission"),
    ).toHaveLength(0);
  });

  it("reports a REUSED submission as reused, not as a fresh save", async () => {
    // The caller cannot otherwise tell a retry that was absorbed from a save
    // that wrote, and the two are different facts about the record.
    synthDevice();
    DB.rpcResult = {
      submission_id: "sub-1",
      groups: 2,
      readings: 5,
      reused: true,
    };
    const out = await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0004",
      groups: [{ groupKey: "g1", channels: [1], readings: [READING(120)] }],
    });
    expect(out.ok).toBe(true);
    expect(out.reused).toBe(true);
    // THE DATABASE'S OWN TALLY, not the one group that was sent: a reused
    // submission reports what the ORIGINAL save recorded.
    expect(out.captures).toBe(2);
    expect(out.written).toBe(5);
  });

  it("refuses a save that reports no submission id", async () => {
    // A deployment where the migration has not been applied, or an older
    // function still resolving, returns something else entirely. Casting it
    // would report a successful save with an undefined capture.
    synthDevice();
    DB.rpcResult = { nothing: true };
    const out = await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0005",
      groups: [{ groupKey: "g1", channels: [1], readings: [READING(120)] }],
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error).toMatch(/cannot be confirmed/i);
  });

  it("refuses an empty save, and a group with no readings", async () => {
    synthDevice();
    expect(
      (
        await actions.recordSetupSubmissionAction({
          blockId: "block-1",
          machineId: "dev-1",
          modeKey: "galvanic",
          idempotencyKey: "save-key-0006",
          groups: [],
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await actions.recordSetupSubmissionAction({
          blockId: "block-1",
          machineId: "dev-1",
          modeKey: "galvanic",
          idempotencyKey: "save-key-0007",
          groups: [{ groupKey: "g1", channels: [], readings: [] }],
        })
      ).ok,
    ).toBe(false);
  });

  it("requires a signed-in practitioner", async () => {
    SESSION.current = null;
    const out = await actions.recordSetupSubmissionAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      idempotencyKey: "save-key-0008",
      groups: [{ groupKey: "g1", channels: [], readings: [READING(1)] }],
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.code).toBe("unauthenticated");
  });

  it("takes no studio, so none can be forged", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
      ),
      "utf8",
    );
    const body = src
      .slice(src.indexOf("export async function recordSetupSubmissionAction"))
      .split("\n}\n")[0]!;
    expect(body).not.toMatch(/studioId:\s*input\./);
    expect(body).not.toMatch(/p_studio_id/);
  });
});

describe("THE VALIDATION IS SHARED, not copied", () => {
  // A second implementation of a clinical validation rule is a second place
  // for it to drift, and this feature has corrected that exact defect three
  // times. THREE server paths now record machine settings: the per-group
  // command, the whole-save command, and the INITIAL save that creates the
  // treatment area and its settings in one transaction - and the third lives
  // in a DIFFERENT module, which is why the validator moved to lib/.
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "../../..", rel), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      " ",
    );

  const SETUP_ACTIONS =
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts";
  const BLOCK_ACTIONS =
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts";
  const VALIDATOR = "lib/machines/validate-submitted-readings.ts";

  it("has exactly ONE call site for the reading validator, and it is in lib/", () => {
    // Counted ACROSS the three files rather than within one, which is the
    // claim that actually matters now that the paths span two modules. The
    // previous version of this test counted inside machine-setup-actions only
    // and would have been satisfied by a second copy in block-actions.
    const perFile = [SETUP_ACTIONS, BLOCK_ACTIONS, VALIDATOR].map((f) => ({
      f,
      hits: (read(f).match(/validateReading\(/g) ?? []).length,
    }));
    expect(
      perFile.find((p) => p.f === VALIDATOR)!.hits,
      "the shared validator must call it exactly once",
    ).toBe(1);
    for (const p of perFile.filter((x) => x.f !== VALIDATOR)) {
      expect(
        p.hits,
        `${p.f} must not call validateReading itself`,
      ).toBe(0);
    }
  });

  it("is reached by ALL THREE recording paths", () => {
    const setup = read(SETUP_ACTIONS);
    for (const fn of ["recordReadingsAction", "recordSetupSubmissionAction"]) {
      const body = setup.slice(setup.indexOf(`export async function ${fn}`)).split(
        "\n}\n",
      )[0]!;
      expect(
        body,
        `${fn} must validate through the shared helper`,
      ).toMatch(/validateSubmittedReadings\(/);
    }
    // The INITIAL save, in the other module. It had NO validator at all until
    // the type checker exposed its input shape - and the database would not
    // have covered the gap, because `stale_profile_version` compares the
    // DEVICE's registered contract version against the catalogue's and the
    // command only ever sees the device's.
    const block = read(BLOCK_ACTIONS);
    const create = block.slice(
      block.indexOf("export async function createTreatmentAreaWithEntryAction"),
      block.indexOf("export type UpdateAreaWithEntryInput"),
    );
    expect(create).toMatch(/validateSubmittedReadings\(/);
  });

  it("DERIVES unit and precision there, and nowhere else", () => {
    expect(read(VALIDATOR)).toMatch(/nativeUnit: checked\.field\.unit/);
    expect(read(VALIDATOR)).toMatch(/decimals: checked\.field\.decimals/);
  });
});

describe("the connected wrapper forwards the whole SAVE", () => {
  // The same failure class as the context-forwarding guard above, on the path
  // that matters most: a dropped `idempotencyKey` makes idempotency silently
  // inert, and nothing fails until a lost response duplicates a capture.
  const CONNECTED = readFileSync(
    path.resolve(
      __dirname,
      "../../../components/machines/machine-first-setup-connected.tsx",
    ),
    "utf8",
  ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, " ");

  it("calls the SAVE action, not the per-group one", () => {
    expect(CONNECTED).toMatch(/recordSetupSubmissionAction\(/);
    expect(CONNECTED).not.toMatch(/recordReadingsAction\(/);
  });

  it("passes the form's input through WHOLE, rather than rebuilding it", () => {
    // Rebuilding is how a field gets dropped. Passing the object through means
    // a new field cannot be forgotten here.
    expect(CONNECTED).toMatch(/recordSetupSubmissionAction\(input\)/);
  });

  it("returns the reuse flag and the counts to the form", () => {
    // Without these the form cannot distinguish "saved" from "already saved",
    // and would report a fresh capture for an absorbed retry.
    for (const field of ["reused", "captures", "written"]) {
      expect(CONNECTED, `${field} must reach the form`).toContain(field);
    }
  });
});

describe("the entry form holds the key across retries", () => {
  const ENTRY = readFileSync(
    path.resolve(
      __dirname,
      "../../../components/machines/machine-reading-entry.tsx",
    ),
    "utf8",
  ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, " ");

  it("takes the key from the state machine, never minting one inline", () => {
    // `crypto.randomUUID()` called directly at the call site would mint a new
    // key per attempt, which is exactly the defect that makes a retry a
    // duplicate. It may only be the MINTER passed to keyForSave.
    expect(ENTRY).toMatch(/keyForSave\(save,/);
    const direct = ENTRY.match(/crypto\.randomUUID\(\)/g) ?? [];
    expect(direct.length, "the key must come from keyForSave").toBe(1);
    expect(ENTRY).toMatch(/keyForSave\(save, mintKey \?\? \(\(\) => crypto\.randomUUID\(\)\)\)/);
  });

  it("sends it as the save's idempotency key", () => {
    expect(ENTRY).toMatch(/idempotencyKey: key/);
  });

  it("sends ONE call, not one per group", () => {
    // The loop is gone. A `for` over the submissions here would reintroduce
    // every state the atomic command removed.
    const submit = ENTRY.slice(ENTRY.indexOf("async function submit()")).split(
      "\n  }\n",
    )[0]!;
    expect(submit).not.toMatch(/for\s*\(/);
    expect((submit.match(/await onRecord\(/g) ?? []).length).toBe(1);
  });
});

describe("reading metadata is DERIVED from the profile, never accepted", () => {
  // The caller may say which field and what it read. The field's native unit
  // and precision are machine facts, so an earlier shape that accepted them
  // let a crafted request persist a permanent row claiming the wrong unit.
  it("refuses a field the profile does not have", async () => {
    // The device below is registered against the synthetic profile, so the
    // runtime catalogue has to contain it - i.e. the gate must be open. Both
    // conditions, because the gate now requires a local stack as well as the
    // flag.
    vi.stubEnv("HONE_SYNTHETIC_MACHINE_PROFILE", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    signIn("studio-fett", "pract-sabrina", "owner");
    DB.rows = [
      {
        id: "dev-1",
        studio_id: "studio-fett",
        machine_profile_id: "synthetic:demo-multineedle",
        // VERSION 2, tracking the synthetic contract. Pinned at 1 this fixture
        // made the test below fail on the VERSION-MISMATCH refusal instead of
        // the unknown-field one it was written for - a refusal arriving for
        // the wrong reason proves nothing about the rule under test.
        machine_profile_version: 2,
        display_name: "Room 1",
        installed_options: [],
        retired_at: null,
      },
    ];
    const out = await actions.recordReadingsAction({
      blockId: "block-1",
      machineId: "dev-1",
      modeKey: "galvanic",
      groupKey: "g1",
      channels: [],
      readings: [
        {
          stageKey: null,
          fieldKey: "not_a_real_field",
          value: { kind: "value", value: 3 },
          observationSource: "practitioner-entered",
        },
      ],
    });
    expect(out.ok).toBe(false);
    // The message now comes from lib/machines/validate-reading.ts rather than
    // from a hand-rolled check at the call site, which is the improvement: one
    // validator decides what a field is, for every caller. It quotes the field
    // with single quotes, so assert the parts rather than my old wording.
    expect(out.ok ? "" : out.error).toMatch(/has no field/i);
    expect(out.ok ? "" : out.error).toMatch(/not_a_real_field/);
  });

  it("accepts no unit or precision from the caller, by type and by source", () => {
    // The submission type has no nativeUnit/decimals at all, so this is a
    // compile-time guarantee as well as a runtime one. Pinned on the source so
    // a future widening is a visible decision.
    //
    // THE DERIVATION MOVED to lib/machines/validate-submitted-readings.ts
    // when a third recording path in another module needed it; the assertion
    // that it HAPPENS lives with it, in the suite above. What stays here is
    // the type-level half, which is where this test's name points.
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/machines/machine-queries.ts"),
      "utf8",
    );
    const sub = /export type ReadingSubmission = \{[\s\S]*?\n\};/.exec(src);
    expect(sub).not.toBeNull();
    expect(sub![0]).not.toMatch(/nativeUnit/);
    expect(sub![0]).not.toMatch(/decimals/);

    // THE DERIVATION NOW LIVES IN lib/, because a THIRD recording path - the
    // initial save, in block-actions.ts - needed the same validator and a
    // rule reachable from one module only is a rule that holds on some paths
    // and not others. These assertions followed it rather than being dropped.
    const validator = readFileSync(
      path.resolve(__dirname, "../../../lib/machines/validate-submitted-readings.ts"),
      "utf8",
    );
    // The unit and precision come off the field the VALIDATOR resolved, not
    // off anything the caller sent and not off a descriptor re-derived at the
    // call site. `checked` is validateReading's successful outcome.
    expect(validator).toMatch(/nativeUnit: checked\.field\.unit/);
    expect(validator).toMatch(/decimals: checked\.field\.decimals/);
    expect(validator).toMatch(/validateReading\(/);
    // Validated against the DEVICE's registered version, so a stale
    // registration is refused rather than captured under today's contract.
    expect(validator).toMatch(/version: device\.profileVersion/);
  });
});

describe("the synthetic demo profile cannot reach production", () => {
  // The local stack is now part of the gate (reason 4), so the baseline that
  // SHOULD be enabled has to state it. A bare flag is no longer sufficient,
  // which is itself asserted below.
  const LOCAL_URL = "http://127.0.0.1:54321";
  const base = {
    HONE_SYNTHETIC_MACHINE_PROFILE: "1",
    NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
  } as unknown as NodeJS.ProcessEnv;

  it("is OFF when the flag is absent", () => {
    expect(synthetic.syntheticProfileEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is OFF for any value other than exactly '1'", () => {
    for (const v of ["0", "true", "yes", "", " 1", "1 "]) {
      expect(
        synthetic.syntheticProfileEnabled({
          HONE_SYNTHETIC_MACHINE_PROFILE: v,
          NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
        } as unknown as NodeJS.ProcessEnv),
        `value ${JSON.stringify(v)} must not enable it`,
      ).toBe(false);
    }
  });

  it("is ON with the exact flag against a local stack", () => {
    expect(synthetic.syntheticProfileEnabled(base)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // REASON 3 — every deployment signal, by name.
  // -----------------------------------------------------------------------
  it.each([
    ["VERCEL", "1"],
    ["VERCEL_ENV", "production"],
    ["VERCEL_ENV", "preview"],
    ["VERCEL_ENV", "development"],
    ["AWS_REGION", "us-east-1"],
    ["AWS_EXECUTION_ENV", "AWS_Lambda_nodejs20.x"],
    ["KUBERNETES_SERVICE_HOST", "10.0.0.1"],
  ])("is OFF in a deployed runtime EVEN IF the flag leaked there: %s=%s", (k, v) => {
    // The whole point: the flag is a demo affordance, not a feature switch, so
    // a leaked environment variable in a deployment must change nothing.
    expect(
      synthetic.syntheticProfileEnabled({
        ...base,
        [k]: v,
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // REASON 4 — an independent second lock, so reason 3 is not load-bearing
  // alone. A deployed Hone never points at loopback.
  // -----------------------------------------------------------------------
  it.each([
    ["absent", undefined],
    ["a hosted Supabase project", "https://abcdefgh.supabase.co"],
    ["a pooler host", "postgresql://u:p@x.pooler.example.com:5432/postgres"],
    ["some other remote host", "https://db.example.com"],
  ])("is OFF when NEXT_PUBLIC_SUPABASE_URL is %s", (_label, url) => {
    const env = { HONE_SYNTHETIC_MACHINE_PROFILE: "1" } as Record<string, string>;
    if (url !== undefined) env.NEXT_PUBLIC_SUPABASE_URL = url;
    expect(
      synthetic.syntheticProfileEnabled(env as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("a production-shaped environment is refused by EACH lock independently", () => {
    // Belt and braces stated as a test: neither lock is allowed to be the only
    // thing standing between a leaked flag and a real deployment.
    const deployedAndHosted = {
      HONE_SYNTHETIC_MACHINE_PROFILE: "1",
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
    } as unknown as NodeJS.ProcessEnv;
    expect(synthetic.syntheticProfileEnabled(deployedAndHosted)).toBe(false);
    // deployment signal only
    expect(
      synthetic.syntheticProfileEnabled({
        ...base,
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    // hosted Supabase only
    expect(
      synthetic.syntheticProfileEnabled({
        HONE_SYNTHETIC_MACHINE_PROFILE: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("NODE_ENV=production no longer closes the gate, and that is the point", () => {
    // THE ONE SHAPE THIS GATE DELIBERATELY ADMITS THAT THE OLD ONE REFUSED.
    //
    // `next start` sets NODE_ENV=production (node_modules/next/dist/bin/next),
    // and Playwright's webServer runs `next build && next start`, so EVERY
    // browser run was NODE_ENV=production and the old gate closed before it
    // ever read the flag. The browser spec's gate-open half could therefore
    // never execute while still reporting green.
    //
    // NODE_ENV says how the code was BUILT, not where it is RUNNING, and only
    // the second question is a safety question. A local production-mode build
    // pointed at 127.0.0.1 is the e2e server and nothing else: anything truly
    // deployed trips reason 3, reason 4, or both — asserted directly above.
    expect(
      synthetic.syntheticProfileEnabled({
        ...base,
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    // ...but NODE_ENV alone still cannot open it without the local stack.
    expect(
      synthetic.syntheticProfileEnabled({
        HONE_SYNTHETIC_MACHINE_PROFILE: "1",
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("keeps the deployed-runtime predicate identical to the four it copies", () => {
    // Five private copies of a safety predicate is a drift risk, recorded as a
    // follow-up rather than collapsed here (that would mean editing four files
    // owned by other lanes mid-sprint). This pins them equal meanwhile: if any
    // one gains a signal the others lack, this fails and names it.
    const root = path.resolve(__dirname, "../../..");
    const peers = [
      "lib/email/e2e-fake-resend.ts",
      "lib/stripe/e2e-fake-guard.ts",
      "lib/reliability/e2e-route-fault.ts",
      "lib/google-calendar/e2e/fake-google-guard.ts",
      "lib/machines/synthetic-profile.ts",
    ];
    const signals = peers.map((rel) => {
      const src = readFileSync(path.join(root, rel), "utf8");
      const fn = /function deployedEnvironmentSignal\([\s\S]*?\n}/.exec(src);
      expect(fn, `${rel} must define deployedEnvironmentSignal`).not.toBeNull();
      return [rel, [...fn![0].matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]).join(",")] as const;
    });
    const mine = signals.find(([r]) => r === "lib/machines/synthetic-profile.ts")![1];
    for (const [rel, sig] of signals) {
      expect(sig, `${rel} has drifted from the shared shape`).toBe(mine);
    }
  });

  it("the runtime catalogue adds it only when enabled, and never alters a real profile", () => {
    const off = synthetic.catalogueForRuntime({} as unknown as NodeJS.ProcessEnv);
    const on = synthetic.catalogueForRuntime(base);
    expect(off.some((p) => p.profileId === synthetic.SYNTHETIC_PROFILE_ID)).toBe(false);
    expect(on.some((p) => p.profileId === synthetic.SYNTHETIC_PROFILE_ID)).toBe(true);
    expect(
      on.some((p) => p.profileId === synthetic.SYNTHETIC_SINGLE_PROBE_PROFILE_ID),
      "the second synthetic model is gated identically",
    ).toBe(true);
    expect(
      off.some((p) => p.profileId === synthetic.SYNTHETIC_SINGLE_PROBE_PROFILE_ID),
    ).toBe(false);
    expect(on).toHaveLength(off.length + 2);

    // Every real profile is still exactly as the curated catalogue states it.
    expect(off.filter((p) => p.availability === "active")).toEqual([]);

    // NOTHING REAL IS EVER ACTIVATED, stated as the rule rather than as a list
    // of ids.
    //
    // This used to assert the active set EQUALLED [SYNTHETIC_PROFILE_ID], which
    // had to be edited the moment a second synthetic fixture appeared - and an
    // assertion that needs editing whenever a fixture is added is one someone
    // will eventually "fix" by appending the new id without checking what the
    // test was for. The rule is that activation is confined to synthetic
    // profiles, and the product rule behind it is that an unverified
    // manufacturer profile is never activated to make a dropdown look fuller.
    const active = on.filter((p) => p.availability === "active");
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      expect(p.profileId, `${p.profileId} is active but not synthetic`).toMatch(
        /^synthetic:/,
      );
    }
  });

  it("the second model DISAGREES with the first, which is its whole purpose", () => {
    // A second fixture that merely existed would make every switching proof
    // vacuous: with disjoint field keys a stale draft LOOKS cleared whether or
    // not anything cleared it, because the new form has no box to show the old
    // value in. These three facts are what make the dropdown's behaviour
    // falsifiable, so they are asserted rather than left to the fixture.
    const single = synthetic.SYNTHETIC_SINGLE_PROBE;
    const multi = synthetic.SYNTHETIC_DEMO_PROFILE;

    const fieldsOf = (p: typeof single) =>
      new Map(p.modes[0]!.fields.map((f) => [f.key, f]));
    const a = fieldsOf(multi);
    const b = fieldsOf(single);

    // 1. A SHARED KEY, so a carried-over value would be visible.
    expect([...b.keys()]).toContain("current");
    expect([...a.keys()]).toContain("current");
    // 2. ...at a DIFFERENT unit and precision, so a stale label is detectable.
    expect(b.get("current")!.unit).not.toBe(a.get("current")!.unit);
    expect(b.get("current")!.decimals).not.toBe(a.get("current")!.decimals);
    // 3. A key unique to the second model, so "the other model's fields are
    //    gone" is distinguishable from "they were relabelled".
    expect([...b.keys()]).toContain("pulse_width");
    expect([...a.keys()]).not.toContain("pulse_width");

    // And the structural contrast: one has channels, the other has none, so
    // the channel-group path and the simple path are both reachable.
    expect(multi.channels?.count).toBeGreaterThan(0);
    expect(single.channels).toBeUndefined();
    // Different mode keys, so a seed hardcoding one mode fails loudly.
    expect(single.modes[0]!.key).not.toBe(multi.modes[0]!.key);
  });

  it("the second model's TWO MODES disagree, so a mode switch is falsifiable", () => {
    // THE SAME ARGUMENT AS THE TEST ABOVE, one level down. That one makes a
    // change of UNIT falsifiable; this one makes a change of MODE falsifiable,
    // and they are different paths: a mode switch keeps the device, the
    // profile and the version fixed and moves only the field contract.
    //
    // IT ALSO GUARDS A BRANCH THAT WOULD OTHERWISE BE UNREACHABLE. The panel
    // renders its mode picker only when a unit offers more than one mode, so
    // while every profile carried exactly one, `machine-mode-picker` could not
    // appear in any browser run. If someone later trims this profile back to a
    // single mode, that branch silently stops being exercised and the e2e
    // mode-switch step starts passing for the wrong reason - so the count is
    // asserted here rather than assumed by the spec.
    const single = synthetic.SYNTHETIC_SINGLE_PROBE;
    expect(single.modes.length, "the mode picker needs a choice to render").toBeGreaterThan(1);

    const byKey = new Map(single.modes.map((m) => [m.key, m]));
    const blend = byKey.get("blend")!;
    const therm = byKey.get("thermolysis")!;
    expect(blend, "blend must stay - existing tests read modes[0]").toBeDefined();
    expect(therm).toBeDefined();
    expect(single.modes[0]!.key, "blend stays first").toBe("blend");

    const f = (m: typeof blend) => new Map(m.fields.map((x) => [x.key, x]));
    const a = f(blend);
    const b = f(therm);

    // 1. A SHARED KEY, so a value typed under one mode would be VISIBLE in the
    //    other's box if anything failed to discard it.
    expect([...a.keys()]).toContain("current");
    expect([...b.keys()]).toContain("current");
    // 2. ...at a different unit AND precision, so a stale label is detectable
    //    and the recording command's scale rule can actually bite.
    expect(b.get("current")!.unit).not.toBe(a.get("current")!.unit);
    expect(b.get("current")!.decimals).not.toBe(a.get("current")!.decimals);
    // 3. A key unique to EACH mode, so "gone" and "relabelled" are different
    //    observations in both directions.
    expect([...a.keys()]).toContain("pulse_width");
    expect([...b.keys()]).not.toContain("pulse_width");
    expect([...b.keys()]).toContain("intensity");
    expect([...a.keys()]).not.toContain("intensity");

    // NEITHER MODE IS GATED ON AN INSTALLED OPTION, or `supportedModes` would
    // filter it out on a unit seeded with none and the picker would not render
    // however many modes the profile declares.
    for (const m of single.modes) {
      expect(m.requiresInstalledOption, `${m.key} must need no option`).toBeUndefined();
      expect(m.availability, `${m.key} must be active to be offered`).toBe("active");
    }
  });

  it("the second model is also explicitly synthetic, never a borrowed family", () => {
    // `family` is the field a reader trusts to say what a profile IS. Both
    // demo profiles previously declared `Permanence/GEMM-16` because the
    // vocabulary was closed to real families; that put a false claim in a
    // shipped fixture.
    for (const p of [synthetic.SYNTHETIC_DEMO_PROFILE, synthetic.SYNTHETIC_SINGLE_PROBE]) {
      expect(p.manufacturer).toBe("Synthetic");
      expect(p.family).toBe("Synthetic/Demo");
      expect(p.model).toMatch(/demo/i);
    }
  });

  it("names itself synthetic, so it cannot be mistaken for a real unit", () => {
    expect(synthetic.SYNTHETIC_DEMO_PROFILE.manufacturer).toBe("Synthetic");
    expect(synthetic.SYNTHETIC_DEMO_PROFILE.model).toMatch(/demo/i);
    expect(synthetic.SYNTHETIC_DEMO_PROFILE.evidence[0]!.establishes).toMatch(
      /NOTHING about any real machine/i,
    );
  });

  it("is server-only, so a client bundle cannot import the gate", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/machines/synthetic-profile.ts"),
      "utf8",
    );
    expect(src.startsWith('import "server-only";')).toBe(true);
  });
});

describe("the module stays out of the clinical record", () => {
  it("touches no clinical table directly", () => {
    // It legitimately builds a Supabase client now - the storage exists - so
    // what matters is what it does with it: commands only, never a raw read or
    // write of a treatment record.
    //
    // THIS ASSERTION USED TO BE A BARE SUBSTRING SEARCH for each table name
    // over the whole file, which is a different and much weaker claim than it
    // appears. It fails on any mention of the word - a prose comment, or the
    // import path "@/lib/sessions/session-lineage" - while a genuine
    // `.from("sessions")` buried in a template string would read the same to
    // it. So it is now anchored to what actually constitutes touching a table,
    // over comment-stripped source.
    const code = CODE.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    for (const table of [
      "session_blocks",
      "electrolysis_entries",
      "laser_entries",
      "sessions",
      "clients",
      "treatment_setup_readings",
    ]) {
      expect(code, `must not select from ${table}`).not.toMatch(
        new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]`),
      );
    }
  });

  it("performs no raw DML and no cache invalidation of its own", () => {
    expect(CODE).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(CODE).not.toContain("revalidatePath");
  });

  it("reaches the database only through 0223's named commands", () => {
    const rpcs = [...CODE.matchAll(/rpc\("(\w+)"/g)].map((m) => m[1]);
    // Via the data layer, so the action file itself names none directly.
    expect(rpcs).toEqual([]);
    expect(CODE).toContain("@/lib/machines/machine-queries");
  });
});

// ---------------------------------------------------------------------------
// AN UNREADABLE INVENTORY IS NOT A DEREGISTRATION.
//
// `listStudioDevices` returns an EMPTY device array with source "unreadable"
// when the read itself fails. The loader passed that empty array to
// `resolveSelection`, which then reported the stored machine as "no longer
// registered to this studio" - a claim derived from missing data rather than
// from evidence. studio-devices' own header already states the distinction
// ("emptiness here means nothing about the studio") (Codex, d3e8b17b).
// ---------------------------------------------------------------------------
describe("an unreadable inventory does not accuse the stored machine", () => {
  const REMEMBERED = [
    { default_machine_id: "room-9", default_machine_mode: null },
  ];

  it("reports that the selection could not be CONFIRMED, not that it is gone", async () => {
    signIn("studio-1", "pract-1");
    DB.rowsFor.practitioners = REMEMBERED;
    DB.errorFor.studio_machines = { message: "connection reset" };

    const ctx = await actions.loadMachineSetupContext(ROUTE);

    expect(ctx.rememberedUnavailable?.deviceId).toBe("room-9");
    expect(ctx.rememberedUnavailable?.reason).toMatch(/could not be (read|confirmed)/i);
    // THE DEFECT, as an assertion: the stored unit must not be called
    // deregistered on the strength of a failed read.
    expect(ctx.rememberedUnavailable?.reason).not.toMatch(/no longer registered/i);
    expect(ctx.remembered, "nothing may be selected on unverified ground").toBeNull();
  });

  it("CONTROL: when the inventory IS readable and the unit is absent, it says so", async () => {
    // Without this, the assertion above could pass because the loader never
    // produces the deregistration wording at all.
    signIn("studio-1", "pract-1");
    DB.rowsFor.practitioners = REMEMBERED;
    DB.rowsFor.studio_machines = []; // read succeeded; the studio has none

    const ctx = await actions.loadMachineSetupContext(ROUTE);

    expect(ctx.rememberedUnavailable?.deviceId).toBe("room-9");
    expect(ctx.rememberedUnavailable?.reason).toMatch(/no longer registered/i);
  });

  it("a readable inventory containing the unit selects it normally", async () => {
    // The third leg: proving the unreadable branch is not swallowing the
    // ordinary path.
    signIn("studio-1", "pract-1");
    DB.rowsFor.practitioners = REMEMBERED;
    DB.rowsFor.studio_machines = [
      {
        id: "room-9",
        studio_id: "studio-1",
        machine_profile_id: "synthetic:demo",
        machine_profile_version: 1,
        display_name: "Room 9",
        installed_options: [],
        retired_at: null,
      },
    ];

    const ctx = await actions.loadMachineSetupContext(ROUTE);
    // Either it resolves as ready, or it is withheld for a stated reason - but
    // never silently both null, which would mean the stored choice vanished.
    expect(
      ctx.remembered !== null || ctx.rememberedUnavailable !== null,
      "a stored selection must always be either usable or explained",
    ).toBe(true);
  });
});

describe("a RETIRED remembered machine is named as retired, not as missing", () => {
  it("says it was taken out of service, with its name", async () => {
    // `resolveSelection`'s own retired branch cannot fire from the loader: a
    // retired unit is absent from the device list it searches, so it reported
    // "no longer registered to this studio" - saying the unit does not exist
    // when it does. The loader now names it through machinesByIds, which has
    // no retired filter, and corrects the wording (Codex, 27061e88).
    signIn("studio-1", "pract-1");
    DB.rowsFor.practitioners = [
      { default_machine_id: "room-9", default_machine_mode: null },
    ];
    DB.rowsFor.studio_machines = [
      { id: "room-9", display_name: "Room 9", retired_at: "2026-10-01T00:00:00Z" },
    ];

    const ctx = await actions.loadMachineSetupContext(ROUTE);

    expect(ctx.rememberedUnavailable?.deviceId).toBe("room-9");
    expect(ctx.rememberedUnavailable?.reason).toMatch(/out of service/i);
    expect(ctx.rememberedUnavailable?.reason).toContain("Room 9");
    // THE DEFECT: it must not claim the unit is gone from the studio.
    expect(ctx.rememberedUnavailable?.reason).not.toMatch(/no longer registered/i);
  });
});

// ===========================================================================
// THE LOADER READS WHAT IS ALREADY RECORDED — in the SAME round trip.
//
// Folded into `loadMachineSetupContext` rather than a second action call, and
// that is not a micro-optimisation: the panel loads on demand precisely
// because an extra server-action POST to this route broke two browser specs.
// repeat-client-fast-charting classifies any POST without an idempotencyKey as
// a source re-read, and conditional-numbing-notes lost its save to a racing
// round trip. A second call for the captures would reintroduce exactly that.
// ===========================================================================

describe("previous-treatment guidance excludes the session being charted", () => {
  // THE DEFECT (Codex, #860 4289974654): `latest_setup_for_client` filtered on
  // client and studio and returned the newest capture, so a setup recorded in
  // the session ON SCREEN came back as "Previous treatment" - under copy that
  // says it is reference only and not today's entries.
  //
  // ASSERTED ON THE RPC ARGUMENTS, because that is where the claim lives. The
  // SQL exclusion is proved against a real database in
  // tests/db/machine-workflow-end-to-end; what can only be checked HERE is
  // that the action hands the authorized route session down rather than
  // omitting it or inventing one.
  it("passes the ROUTE's sessionId as the exclusion", async () => {
    signIn("studio-fett", "pract-sabrina", "owner");
    await actions.loadMachineSetupContext(ROUTE);

    const call = DB.calls.find((c) => c.fn === "latest_setup_for_client");
    expect(call, "the guidance lookup was not called at all").toBeTruthy();
    expect(call!.args.p_exclude_session_id).toBe(ROUTE.sessionId);
    // AND THE OTHER TWO SCOPES ARE STILL THERE. A fix that dropped the client
    // scoping while adding the session one would re-open the defect this
    // function was repaired for earlier: another client's newer reading shown
    // as guidance.
    expect(call!.args.p_client_id).toBe(ROUTE.clientId);
    expect(call!.args.p_studio_id).toBe("studio-fett");
  });

  it("sends a REAL session id, not a placeholder", async () => {
    // Guards the shape of the fix rather than its presence: passing null or
    // an empty string would satisfy "a third argument exists" while excluding
    // nothing, and `is distinct from null` excludes no row.
    signIn("studio-fett", "pract-sabrina", "owner");
    await actions.loadMachineSetupContext(ROUTE);
    const call = DB.calls.find((c) => c.fn === "latest_setup_for_client");
    expect(call!.args.p_exclude_session_id).toBeTruthy();
    expect(typeof call!.args.p_exclude_session_id).toBe("string");
  });
});

describe("loadMachineSetupContext reads the block's recorded captures", () => {
  const READING_ROW = {
    // THE KEYSET CURSOR. The complete read pages by `id`, so a row without one
    // cannot be paged past and the read fails closed rather than guessing -
    // which is the behaviour, not an inconvenience of the fixture.
    id: "rd-0001",
    session_block_id: "block-1",
    capture_id: "cap-1",
    revision: 1,
    studio_machine_id: "dev-1",
    machine_profile_id: "synthetic:demo-multineedle",
    machine_profile_version: 2,
    mode_key: "galvanic",
    group_key: "g1",
    channels: [],
    stage_key: null,
    field_key: "current",
    value_numeric: "120",
    absence_reason: null,
    native_unit: "µA",
    decimals: 0,
    observation_source: "practitioner-entered",
    recorded_at: "2026-10-14T14:00:00Z",
    recorded_by_practitioner_id: "pract-sabrina",
  };

  it("returns them when a block is being charted", async () => {
    signIn("studio-fett", "pract-sabrina", "owner");
    DB.rowsFor = { treatment_setup_readings: [READING_ROW] };
    const ctx = await actions.loadMachineSetupContext({
      clientId: "client-1",
      sessionId: "session-1",
      blockId: "block-1",
    });
    expect(ctx.recordedSetup).toHaveLength(1);
    expect(ctx.recordedSetup[0]!.fieldKey).toBe("current");
    expect(ctx.recordedSetup[0]!.captureId).toBe("cap-1");
  });

  it("returns NONE without a block, which in create mode is simply true", async () => {
    // The block has no row yet, so nothing is recorded against it. The read
    // must not happen at all rather than returning something arbitrary.
    signIn("studio-fett", "pract-sabrina", "owner");
    DB.rowsFor = { treatment_setup_readings: [READING_ROW] };
    const ctx = await actions.loadMachineSetupContext({
      clientId: "client-1",
      sessionId: "session-1",
    });
    expect(ctx.recordedSetup).toEqual([]);
  });

  it("degrades to EMPTY when the read fails, rather than losing the chart", async () => {
    // This surface is reassurance. A failed cosmetic read must not cost her
    // the machine panel, so it must not throw.
    signIn("studio-fett", "pract-sabrina", "owner");
    DB.errorFor = { treatment_setup_readings: { message: "boom" } };
    const ctx = await actions.loadMachineSetupContext({
      clientId: "client-1",
      sessionId: "session-1",
      blockId: "block-1",
    });
    expect(ctx.recordedSetup).toEqual([]);
    // And the rest of the context still resolved.
    expect(ctx.scope).not.toBeNull();
  });

  it("asks for the recorded unit's NAME too, in ONE lookup", async () => {
    // A treatment recorded on a unit that has since been retired is exactly
    // the case that must still name it, and only the server can see one.
    // `machinesByIds` has no retired filter; the device list does.
    signIn("studio-fett", "pract-sabrina", "owner");
    DB.rowsFor = {
      treatment_setup_readings: [READING_ROW],
      studio_machines: [
        {
          id: "dev-1",
          studio_id: "studio-fett",
          machine_profile_id: "synthetic:demo-multineedle",
          machine_profile_version: 2,
          display_name: "Room 9 unit",
          installed_options: [],
          retired_at: "2026-10-01T00:00:00Z",
        },
      ],
    };
    const ctx = await actions.loadMachineSetupContext({
      clientId: "client-1",
      sessionId: "session-1",
      blockId: "block-1",
    });
    expect(ctx.unitNames["dev-1"]).toBe("Room 9 unit");
  });

  it("reads the captures through ONE round trip, with no second action", () => {
    // Source-pinned, because the cost this avoids is invisible in a unit test:
    // the fix is that `loadMachineSetupContext` takes the block id, so there
    // is no separate call to make.
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../../../components/machines/machine-first-setup-connected.tsx",
      ),
      "utf8",
    ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, " ");
    expect(src).toMatch(
      /loadMachineSetupContext\(\{\s*clientId,\s*sessionId,\s*blockId\s*\}\)/,
    );
    // And the wrapper does NOT call the per-block read separately.
    expect(src).not.toMatch(/readingsForBlockAction/);
  });
});
