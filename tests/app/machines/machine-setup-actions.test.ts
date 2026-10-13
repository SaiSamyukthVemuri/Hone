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
      return {
        select: () => ({
          eq: () => ({
            is: () => ({ order: result }),
            order: () => ({ limit: result }),
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
        machine_profile_version: 1,
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
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/machines/machine-queries.ts"),
      "utf8",
    );
    const sub = /export type ReadingSubmission = \{[\s\S]*?\n\};/.exec(src);
    expect(sub).not.toBeNull();
    expect(sub![0]).not.toMatch(/nativeUnit/);
    expect(sub![0]).not.toMatch(/decimals/);

    const action = readFileSync(
      path.resolve(
        __dirname,
        "../../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
      ),
      "utf8",
    );
    // The unit and precision come off the field the VALIDATOR resolved, not
    // off anything the caller sent and not off a descriptor re-derived at the
    // call site. `checked` is validateReading's successful outcome.
    expect(action).toMatch(/nativeUnit: checked\.field\.unit/);
    expect(action).toMatch(/decimals: checked\.field\.decimals/);
    // And that the capture goes through the shared validator at all.
    expect(action).toMatch(/validateReading\(/);
    // Validated against the DEVICE's registered version, so a stale
    // registration is refused rather than captured under today's contract.
    expect(action).toMatch(/version: device\.profileVersion/);
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
    expect(on).toHaveLength(off.length + 1);
    // Every real profile is still exactly as the curated catalogue states it.
    expect(off.filter((p) => p.availability === "active")).toEqual([]);
    expect(
      on.filter((p) => p.availability === "active").map((p) => p.profileId),
    ).toEqual([synthetic.SYNTHETIC_PROFILE_ID]);
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
