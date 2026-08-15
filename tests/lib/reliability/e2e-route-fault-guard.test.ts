import { describe, expect, it } from "vitest";
import {
  asRouteFaultCase,
  assertRouteFaultNotRequestedInDeployment,
  E2E_ROUTE_FAULT_CANARY,
  E2E_ROUTE_FAULT_CASES,
  isE2eRouteFaultEnabled,
  shouldFailOnceForToken,
} from "@/lib/reliability/e2e-route-fault";

// The failure-injection route must be unreachable in every deployed build.
// Same matrix as tests/lib/google-calendar/e2e/fake-google-guard.test.ts and
// tests/lib/stripe/e2e-fake-stripe.test.ts.

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ON = { HONE_E2E_ROUTE_FAULT: "1" };

describe("fault injection is OFF unless explicitly requested", () => {
  it("is off with an empty environment", () => {
    expect(isE2eRouteFaultEnabled(env({}))).toBe(false);
  });

  it("is off for every near-miss marker value", () => {
    for (const value of ["", "0", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      expect(
        isE2eRouteFaultEnabled(env({ HONE_E2E_ROUTE_FAULT: value })),
        `HONE_E2E_ROUTE_FAULT=${JSON.stringify(value)} must not enable it`,
      ).toBe(false);
    }
  });

  it("is on ONLY for the exact marker, off the deployed runtimes", () => {
    expect(isE2eRouteFaultEnabled(env(ON))).toBe(true);
  });
});

describe("fault injection is REFUSED in any deployed runtime", () => {
  const DEPLOYED: Array<[string, Record<string, string>]> = [
    ["Vercel", { VERCEL: "1" }],
    ["Vercel production", { VERCEL_ENV: "production" }],
    ["Vercel preview", { VERCEL_ENV: "preview" }],
    ["Vercel development env", { VERCEL_ENV: "development" }],
    ["AWS region", { AWS_REGION: "us-east-1" }],
    ["AWS execution env", { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" }],
    ["Kubernetes", { KUBERNETES_SERVICE_HOST: "10.0.0.1" }],
  ];

  it("stays disabled even WITH the marker present", () => {
    for (const [name, signal] of DEPLOYED) {
      expect(
        isE2eRouteFaultEnabled(env({ ...ON, ...signal })),
        `${name} must refuse fault injection`,
      ).toBe(false);
    }
  });

  it("fails LOUD rather than silently ignoring a requested marker", () => {
    for (const [name, signal] of DEPLOYED) {
      expect(
        () => assertRouteFaultNotRequestedInDeployment(env({ ...ON, ...signal })),
        `${name} must throw`,
      ).toThrow(/must never be set in a deployed environment/);
    }
  });

  it("the fail-loud guard is a no-op when the marker is absent, i.e. in production", () => {
    for (const [, signal] of DEPLOYED) {
      expect(() =>
        assertRouteFaultNotRequestedInDeployment(env(signal)),
      ).not.toThrow();
    }
    expect(() => assertRouteFaultNotRequestedInDeployment(env({}))).not.toThrow();
  });

  it("NODE_ENV is NOT the gate, because the local E2E lane runs next start", () => {
    // Gating on NODE_ENV=production would disable the only environment this
    // exists for. The real boundary is the positive marker plus the deployment
    // refusal, a combination that cannot occur in a deployed runtime.
    expect(
      isE2eRouteFaultEnabled(env({ ...ON, NODE_ENV: "production" })),
    ).toBe(true);
    expect(
      isE2eRouteFaultEnabled(env({ NODE_ENV: "development" })),
    ).toBe(false);
  });
});

describe("the marker cannot be reached from a request", () => {
  it("is a server-only variable name, never NEXT_PUBLIC_*", () => {
    // A NEXT_PUBLIC_ name would be inlined into the browser bundle and become
    // settable/observable from the client.
    expect("HONE_E2E_ROUTE_FAULT".startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});

describe("case parsing is an allowlist", () => {
  it("accepts exactly the declared cases", () => {
    for (const c of E2E_ROUTE_FAULT_CASES) {
      expect(asRouteFaultCase(c)).toBe(c);
    }
  });

  it("rejects anything else, so an unknown segment 404s", () => {
    for (const bad of [
      "",
      "OK",
      "server_throw",
      "../../etc/passwd",
      "server-throw ",
      "throw",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(asRouteFaultCase(bad), `${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("the once-token bookkeeping makes Try again provable", () => {
  it("fails the first time and succeeds afterwards, per token", () => {
    const a = "token-a";
    const b = "token-b";
    expect(shouldFailOnceForToken(a)).toBe(true);
    expect(shouldFailOnceForToken(a)).toBe(false);
    expect(shouldFailOnceForToken(a)).toBe(false);
    // Independent per token, so a retried test run gets a fresh failure and
    // cannot pass vacuously against already-recovered state.
    expect(shouldFailOnceForToken(b)).toBe(true);
    expect(shouldFailOnceForToken(b)).toBe(false);
  });
});

describe("the canary is shaped like real leaked database text", () => {
  it("looks like the raw PostgREST message real loaders interpolate", () => {
    // lib/** throws `Failed to load clients: ${error.message}` in 78 places.
    // The canary has to resemble that, or the leak assertion proves nothing
    // about the strings that would actually leak.
    expect(E2E_ROUTE_FAULT_CANARY).toContain('relation "clients" does not exist');
    expect(E2E_ROUTE_FAULT_CANARY).toContain("HONE-LEAK-CANARY-9f3c1d");
  });
});
