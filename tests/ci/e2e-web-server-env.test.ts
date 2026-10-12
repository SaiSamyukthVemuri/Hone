import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// The browser lane's server environment: what is armed unconditionally, and
// what must stay behind a switch.
//
// WHY THIS FILE EXISTS. `webServer.env` REPLACES `process.env` for the Next
// server a browser run drives, so `E2E_WEB_SERVER_ENV` is the only place a
// server-visible variable can come from. Some entries there are armed for
// every run on purpose — the fake Resend transport, the route-fault marker —
// each with a module-level guard that refuses to exist in a deployed runtime.
// Others must be forwarded ONLY when the outer process asks, because arming
// them for the whole lane would destroy the regression value of the ordinary
// run.
//
// `HONE_SYNTHETIC_MACHINE_PROFILE` is firmly in the second group. Every real
// machine model is evidence-gated and blocked, so the ordinary extended run is
// itself the proof that no real model is ever offered. Arming the synthetic
// profile lane-wide would delete that proof. This file is the guard that keeps
// the spread conditional, asserted both on the SOURCE and on the actual
// exported object.
// ===========================================================================

const LOCAL_ENV_PATH = path.resolve(__dirname, "../../e2e/helpers/local-env.ts");
const SRC = readFileSync(LOCAL_ENV_PATH, "utf8");

/** Comment-stripped, because the prose here legitimately discusses the flag. */
const CODE = SRC.split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

/** Load a fresh copy of the module under a given environment. */
async function envUnder(
  vars: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, v);
  }
  // `vi.stubEnv(k, "")` leaves an empty string rather than deleting, which is
  // still falsy for an `=== "1"` test, so it models "not set" correctly here.
  const mod = await import("@/e2e/helpers/local-env");
  return mod.E2E_WEB_SERVER_ENV;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the synthetic machine profile is forwarded only on request", () => {
  it("is ABSENT from the server env when the outer process does not ask", async () => {
    const env = await envUnder({ HONE_SYNTHETIC_MACHINE_PROFILE: undefined });
    expect(
      "HONE_SYNTHETIC_MACHINE_PROFILE" in env,
      "the ordinary browser run must stay gate-closed",
    ).toBe(false);
  });

  it("is PRESENT when the outer process sets exactly '1'", async () => {
    const env = await envUnder({ HONE_SYNTHETIC_MACHINE_PROFILE: "1" });
    expect(env.HONE_SYNTHETIC_MACHINE_PROFILE).toBe("1");
  });

  it.each(["0", "true", "yes", " 1", "1 ", "01"])(
    "stays absent for a near-miss value: %s",
    async (value) => {
      // The server-side gate requires exactly "1". If this forward were looser
      // than the gate, a run could believe it was gate-open and silently not
      // be — the confusing failure this pins shut.
      const env = await envUnder({ HONE_SYNTHETIC_MACHINE_PROFILE: value });
      expect("HONE_SYNTHETIC_MACHINE_PROFILE" in env).toBe(false);
    },
  );

  it("forwards NOTHING else when asked for the synthetic profile", async () => {
    // A conditional spread that accidentally carried a sibling would arm two
    // things from one switch.
    const off = await envUnder({ HONE_SYNTHETIC_MACHINE_PROFILE: undefined });
    const on = await envUnder({ HONE_SYNTHETIC_MACHINE_PROFILE: "1" });
    const added = Object.keys(on).filter((k) => !(k in off));
    expect(added).toEqual(["HONE_SYNTHETIC_MACHINE_PROFILE"]);
  });
});

describe("the source keeps the spread conditional", () => {
  it("declares the flag ONLY inside a conditional spread", () => {
    // The shape that matters, pinned on the source as well as the object:
    // a future edit that hoists it to a plain entry would still fail the
    // runtime cases above, but this says why in one line at the site.
    expect(CODE).toMatch(
      /\.\.\.\(process\.env\.HONE_SYNTHETIC_MACHINE_PROFILE === "1"\s*\?\s*\{\s*HONE_SYNTHETIC_MACHINE_PROFILE: "1"\s*\}\s*:\s*\{\}\),/,
    );
  });

  it("carries no UNCONDITIONAL entry for it", () => {
    // i.e. no bare `HONE_SYNTHETIC_MACHINE_PROFILE: "..."` outside a spread.
    const unconditional = CODE.split("\n").filter(
      (l) =>
        /^\s*HONE_SYNTHETIC_MACHINE_PROFILE\s*:/.test(l) &&
        !l.includes("process.env"),
    );
    expect(unconditional).toEqual([]);
  });

  it("matches the precedent it was modelled on", () => {
    // HONE_PERF_TIMING is the established pattern for exactly this problem and
    // must keep its own conditional shape; if it is ever made unconditional,
    // the reasoning this file cites has moved and should be re-read.
    expect(CODE).toMatch(
      /\.\.\.\(process\.env\.HONE_PERF_TIMING === "1" \? \{ HONE_PERF_TIMING: "1" \} : \{\}\),/,
    );
  });

  it("keeps the deliberately unconditional markers unconditional", () => {
    // The two entries that ARE armed for every run, each with a module-level
    // guard that refuses a deployed runtime. Listed so that "make it
    // conditional" and "make it unconditional" are both visible decisions
    // rather than silent drift in either direction.
    expect(CODE).toMatch(/^\s*HONE_E2E_FAKE_RESEND: "1",$/m);
    expect(CODE).toMatch(/^\s*HONE_E2E_ROUTE_FAULT: "1",$/m);
  });
});
