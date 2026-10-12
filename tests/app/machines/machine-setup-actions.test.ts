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
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => SESSION.current,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      DB.calls.push({ fn, args });
      return { data: DB.rpcResult, error: DB.rpcError };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: async () => ({
              data: DB.selectError ? null : DB.rows,
              error: DB.selectError,
            }),
          }),
          order: () => ({
            limit: async () => ({
              data: DB.selectError ? null : DB.rows,
              error: DB.selectError,
            }),
          }),
        }),
      }),
    }),
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
  DB.calls = [];
});

// ---------------------------------------------------------------------------

describe("ownership cannot be submitted", () => {
  it("loadMachineSetupContext accepts NO arguments at all", () => {
    expect(actions.loadMachineSetupContext.length).toBe(0);
    expect(actions.listSelectableForCaller.length).toBe(0);
    expect(actions.clearMachineSelectionAction.length).toBe(0);
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
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.scope).toBeNull();
    expect(ctx.devices).toEqual([]);
    expect(ctx.catalogue).toEqual([]);
    expect(ctx.canManageMachines).toBe(false);
    expect(ctx.priorSetup).toEqual([]);
    expect(ctx.persistence.persisted).toBe(false);
  });

  it("an authenticated request gets ITS OWN scope, derived not supplied", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.scope).toEqual({
      studioId: "studio-fett",
      practitionerId: "pract-sabrina",
    });
  });

  it("switching session identity switches the scope, with no client input", async () => {
    signIn("studio-one", "pract-a");
    expect((await actions.loadMachineSetupContext()).scope?.studioId).toBe("studio-one");
    signIn("studio-two", "pract-b");
    expect((await actions.loadMachineSetupContext()).scope?.studioId).toBe("studio-two");
  });

  it("reports DATABASE persistence when the remembered read succeeds", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.persistence.kind).toBe("database");
    expect(ctx.persistence.persisted).toBe(true);
  });

  it("falls back to NO persistence when that read FAILS, rather than claiming it", async () => {
    signIn("studio-fett", "pract-sabrina");
    DB.selectError = { message: "connection reset" };
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.persistence.kind).toBe("none");
    // And the inventory read failing is reported as unreadable, not as empty.
    expect(ctx.inventoryReason).toMatch(/do not add a\s+duplicate/i);
  });

  it("an empty studio is reported as empty, not unreadable", async () => {
    signIn("studio-fett", "pract-sabrina");
    const ctx = await actions.loadMachineSetupContext();
    expect(ctx.inventoryReason).toMatch(/no machine registered yet/i);
  });

  it("only an owner may manage machines", async () => {
    signIn("studio-fett", "pract-sabrina", "practitioner");
    expect((await actions.loadMachineSetupContext()).canManageMachines).toBe(false);
    signIn("studio-fett", "pract-sabrina", "owner");
    expect((await actions.loadMachineSetupContext()).canManageMachines).toBe(true);
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

describe("the synthetic demo profile cannot reach production", () => {
  const base = { HONE_SYNTHETIC_MACHINE_PROFILE: "1" } as unknown as NodeJS.ProcessEnv;

  it("is OFF when the flag is absent", () => {
    expect(synthetic.syntheticProfileEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is OFF for any value other than exactly '1'", () => {
    for (const v of ["0", "true", "yes", "", " 1", "1 "]) {
      expect(
        synthetic.syntheticProfileEnabled({
          HONE_SYNTHETIC_MACHINE_PROFILE: v,
        } as unknown as NodeJS.ProcessEnv),
        `value ${JSON.stringify(v)} must not enable it`,
      ).toBe(false);
    }
  });

  it("is ON with the exact flag outside production", () => {
    expect(synthetic.syntheticProfileEnabled(base)).toBe(true);
  });

  it("is OFF in production EVEN IF the flag leaked there", () => {
    // The whole point: the flag is a demo affordance, not a feature switch, so
    // a leaked environment variable in production must change nothing.
    expect(
      synthetic.syntheticProfileEnabled({
        ...base,
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      synthetic.syntheticProfileEnabled({
        ...base,
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
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
    // what matters is what it does with it: commands only, never a raw write
    // to a treatment record.
    for (const table of [
      "session_blocks",
      "electrolysis_entries",
      "laser_entries",
      "sessions",
      "clients",
    ]) {
      expect(CODE, `must not touch ${table}`).not.toContain(table);
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
