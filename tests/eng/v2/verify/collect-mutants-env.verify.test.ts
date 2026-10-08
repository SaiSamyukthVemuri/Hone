/* eslint-disable @typescript-eslint/no-explicit-any -- the mocked child_process signatures are untyped on purpose */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ===========================================================================
// INDEPENDENT VERIFIER — mutant "the child inherits the caller's environment"
// (SPEC-05A §5.1 "a child environment built from nothing … No credential is
// inherited"). node:child_process is wrapped so that, while the mutant is ON,
// every child gets process.env merged under whatever env the primitive passed.
// The primitive's source is neither read nor edited: only its process boundary.
// ===========================================================================

const { mutant, wrapChildProcess } = vi.hoisted(() => {
  const mutant = { inheritEnv: false };
  const wrapChildProcess = (actual: any) => {
    const merge = (opts: any) => (mutant.inheritEnv && opts && typeof opts === "object" ? { ...opts, env: { ...process.env, ...(opts.env ?? {}) } } : opts);
    const w: any = { ...actual };
    for (const fn of ["spawnSync", "execFileSync", "spawn", "execFile"])
      w[fn] = (cmd: any, args?: any, opts?: any, ...rest: any[]) => (Array.isArray(args) ? actual[fn](cmd, args, merge(opts), ...rest) : actual[fn](cmd, merge(args), opts, ...rest));
    for (const fn of ["execSync", "exec"]) w[fn] = (cmd: any, opts?: any, ...rest: any[]) => actual[fn](cmd, merge(opts), ...rest);
    return { ...w, default: w };
  };
  return { mutant, wrapChildProcess };
});
vi.mock("node:child_process", async (importOriginal) => wrapChildProcess(await importOriginal()));
vi.mock("child_process", async (importOriginal) => wrapChildProcess(await importOriginal()));

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createPrimitive as realCreatePrimitive } from "../../../../scripts/eng/v2/adapter/internal/github/primitive.mjs";
import { fakeGhKit, primitiveRows, type FakeGhKit } from "./support/fake-gh";
import { primitiveHomes } from "./support/temp-home";
import { budgetGuard, SLOW_ROW_MS } from "./support/budgets";

describe("primitive mutation detection: an inherited environment (SPEC-05A §5.1)", { timeout: SLOW_ROW_MS }, () => {
  const homes = primitiveHomes();
  const createPrimitive = homes.wrap(realCreatePrimitive);
  afterEach(() => homes.closeAll());
  let kit: FakeGhKit;
  let rows: ReturnType<typeof primitiveRows>;
  beforeAll(() => {
    homes.setup();
    kit = fakeGhKit();
    rows = primitiveRows(kit, kit.make("json", `process.stdout.write(JSON.stringify({ hello: "world" }));`));
  });
  afterAll(() => {
    kit.cleanup();
    homes.teardown();
  });

  it("baseline (wrapper OFF): the child environment is built from nothing", () => {
    mutant.inheritEnv = false;
    expect(rows["PT-child-env-from-nothing"](createPrimitive)).toBeNull();
  });

  it("detects the UNSAFE mutant (wrapper ON): the child inherits the caller's environment", () => {
    mutant.inheritEnv = true;
    try {
      expect(rows["PT-child-env-from-nothing"](createPrimitive)).toMatch(/inherited/);
    } finally {
      mutant.inheritEnv = false;
    }
  });

  it("hygiene: no primitive home is left behind by these rows (SPEC-05A §5.1: close() removes it)", () => {
    expect(homes.maxSeen()).toBeGreaterThan(0);
    expect(homes.leftovers()).toEqual([]);
  });
});

budgetGuard("collect-mutants-env.verify.test.ts");
