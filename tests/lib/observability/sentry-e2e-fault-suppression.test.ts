import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  beforeSendWithE2eFaultSuppression,
  isDeliberateE2eFaultEvent,
} from "@/lib/observability/sentry-e2e-fault";
import { E2E_ROUTE_FAULT_CANARY } from "@/lib/reliability/e2e-route-fault";

// SENTRY-NOISE-01. Suppression requires a CONJUNCTION: the exact deliberate
// canary AND positive server-side harness context. Either half alone has
// already been shown unsafe — route identity suppresses real errors raised on
// the harness route, and the canary alone is forgeable through
// request-controlled text (see the module header for the live /calendar path).

const REDACTED = "[Redacted]";
const HARNESS_MESSAGE = `Failed to load fault fixture: ${E2E_ROUTE_FAULT_CANARY}`;

/** Harness provably active: the marker set, and no deployed-runtime signal. */
const HARNESS_ON = { HONE_E2E_ROUTE_FAULT: "1" } as unknown as NodeJS.ProcessEnv;
/** Production: the marker is set nowhere. */
const HARNESS_OFF = {} as unknown as NodeJS.ProcessEnv;
/** Misconfiguration: marker requested in a deployed runtime. */
const DEPLOYED = {
  HONE_E2E_ROUTE_FAULT: "1",
  VERCEL: "1",
} as unknown as NodeJS.ProcessEnv;

function errorEvent(parts: {
  value?: string;
  message?: string;
  type?: string;
  transaction?: string;
  url?: string;
}): ErrorEvent {
  const e: Record<string, unknown> = {};
  if (parts.message !== undefined) e.message = parts.message;
  if (parts.value !== undefined) {
    e.exception = { values: [{ type: parts.type ?? "Error", value: parts.value }] };
  }
  if (parts.transaction !== undefined) e.transaction = parts.transaction;
  if (parts.url !== undefined) e.request = { url: parts.url };
  return e as unknown as ErrorEvent;
}

/** Source with comments removed, so a guard matches CODE and not prose. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DROPPED: the deliberate harness fault, canary AND positive context", () => {
  it("drops the server throw", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      transaction: "/e2e-fault/[case]",
    });
    expect(isDeliberateE2eFaultEvent(event, HARNESS_ON)).toBe(true);
  });

  it("drops it with no route information at all", () => {
    expect(
      isDeliberateE2eFaultEvent(errorEvent({ value: HARNESS_MESSAGE }), HARNESS_ON),
    ).toBe(true);
  });

  it("drops a message-only event carrying the canary", () => {
    expect(
      isDeliberateE2eFaultEvent(errorEvent({ message: HARNESS_MESSAGE }), HARNESS_ON),
    ).toBe(true);
  });

  it("the beforeSend hook returns null for it", () => {
    vi.stubEnv("HONE_E2E_ROUTE_FAULT", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(
      beforeSendWithE2eFaultSuppression(errorEvent({ value: HARNESS_MESSAGE })),
    ).toBeNull();
  });
});

describe("KEPT: an attacker-controlled canary in a real production error", () => {
  // The live path: app/(app)/calendar/page.tsx passes params.month through
  // unvalidated, and lib/booking/month-grid.ts interpolates it into the throw.
  const forged = errorEvent({
    value: `Invalid YYYY-MM-DD date string: ${E2E_ROUTE_FAULT_CANARY}`,
    transaction: "/calendar",
    url: `https://hone.care/calendar?view=month&month=${encodeURIComponent(E2E_ROUTE_FAULT_CANARY)}`,
  });

  it("is KEPT in production, where the harness is not active", () => {
    expect(isDeliberateE2eFaultEvent(forged, HARNESS_OFF)).toBe(false);
  });

  it("is KEPT even when the marker is requested in a DEPLOYED runtime", () => {
    expect(isDeliberateE2eFaultEvent(forged, DEPLOYED)).toBe(false);
  });

  it("the beforeSend hook keeps and scrubs it", () => {
    const kept = beforeSendWithE2eFaultSuppression(forged);
    expect(kept).not.toBeNull();
  });

  it("marker-only suppression is forbidden: canary + harness OFF => KEPT", () => {
    expect(
      isDeliberateE2eFaultEvent(errorEvent({ value: HARNESS_MESSAGE }), HARNESS_OFF),
    ).toBe(false);
  });
});

describe("KEPT: an unexpected error on or in the harness", () => {
  const onHarness = {
    transaction: "/e2e-fault/[case]",
    url: "http://localhost:3141/e2e-fault/server-throw",
  };

  const cases: Array<[string, Parameters<typeof errorEvent>[0]]> = [
    ["unexpected TypeError on /e2e-fault/ok", {
      value: "Cannot read properties of undefined (reading 'token')",
      type: "TypeError",
      transaction: "/e2e-fault/[case]",
      url: "http://localhost:3141/e2e-fault/ok",
    }],
    ["unrelated TypeError on /e2e-fault/server-throw", {
      value: "x.map is not a function", type: "TypeError", ...onHarness,
    }],
    ["React production-elision text on the harness route", {
      value:
        "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
      ...onHarness,
    }],
    ["cookies() misuse on the harness route", {
      value: "`cookies()` was called outside a request scope.", ...onHarness,
    }],
  ];

  for (const [label, parts] of cases) {
    it(`route-only suppression is forbidden: ${label} => KEPT even with the harness ON`, () => {
      const event = errorEvent(parts);
      expect(isDeliberateE2eFaultEvent(event, HARNESS_ON), label).toBe(false);
      expect(isDeliberateE2eFaultEvent(event, HARNESS_OFF), label).toBe(false);
    });
  }
});

describe("KEPT: the deployment-guard sentinel always wins", () => {
  const guard =
    "HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (VERCEL).";

  it("is kept in a deployed runtime", () => {
    expect(
      isDeliberateE2eFaultEvent(errorEvent({ value: guard }), DEPLOYED),
    ).toBe(false);
  });

  it("is kept even with the harness ON and the canary present beside it", () => {
    const event = errorEvent({
      value: `${guard} ${E2E_ROUTE_FAULT_CANARY}`,
      transaction: "/e2e-fault/[case]",
    });
    expect(isDeliberateE2eFaultEvent(event, HARNESS_ON)).toBe(false);
  });

  it("the beforeSend hook keeps it", () => {
    vi.stubEnv("HONE_E2E_ROUTE_FAULT", "1");
    expect(
      beforeSendWithE2eFaultSuppression(errorEvent({ value: guard })),
    ).not.toBeNull();
  });
});

describe("KEPT: ordinary error classes, in both environments", () => {
  const classes: Array<[string, string, string | undefined]> = [
    ["generic relation clients", 'relation "clients" does not exist', undefined],
    ["cookies()", "`cookies()` was called outside a request scope.", undefined],
    ["after()", "`after()` was called outside a request scope.", undefined],
    ["Failed to fetch", "Failed to fetch", "TypeError"],
    ["No active practitioner found", "No active practitioner found", undefined],
    ["Failed Server Action", "Failed Server Action", undefined],
    ["a 500", "Request failed with status code 500", undefined],
  ];

  for (const [label, value, type] of classes) {
    it(`keeps: ${label}`, () => {
      const event = errorEvent({ value, type, transaction: "/dashboard" });
      expect(isDeliberateE2eFaultEvent(event, HARNESS_ON), label).toBe(false);
      expect(isDeliberateE2eFaultEvent(event, HARNESS_OFF), label).toBe(false);
    });
  }

  it("keeps the harness message with the canary removed (non-vacuity)", () => {
    const withoutCanary = HARNESS_MESSAGE.replace(E2E_ROUTE_FAULT_CANARY, "");
    expect(withoutCanary).not.toContain(E2E_ROUTE_FAULT_CANARY);
    expect(
      isDeliberateE2eFaultEvent(errorEvent({ value: withoutCanary }), HARNESS_ON),
    ).toBe(false);
  });
});

describe("fail open whenever harness identity cannot be established", () => {
  for (const [label, env] of [
    ["no marker at all", {}],
    ["marker not exactly \"1\"", { HONE_E2E_ROUTE_FAULT: "true" }],
    ["VERCEL=1", { HONE_E2E_ROUTE_FAULT: "1", VERCEL: "1" }],
    ["VERCEL_ENV set", { HONE_E2E_ROUTE_FAULT: "1", VERCEL_ENV: "preview" }],
    ["AWS", { HONE_E2E_ROUTE_FAULT: "1", AWS_REGION: "us-east-1" }],
    ["Kubernetes", { HONE_E2E_ROUTE_FAULT: "1", KUBERNETES_SERVICE_HOST: "10.0.0.1" }],
  ] as Array<[string, Record<string, string>]>) {
    it(`keeps the canary-bearing event when: ${label}`, () => {
      expect(
        isDeliberateE2eFaultEvent(
          errorEvent({ value: HARNESS_MESSAGE }),
          env as unknown as NodeJS.ProcessEnv,
        ),
        label,
      ).toBe(false);
    });
  }
});

describe("kept events still run the privacy scrub", () => {
  it("redacts an email in a kept event", () => {
    const kept = beforeSendWithE2eFaultSuppression(
      errorEvent({ value: "Failed to load client jane.doe@example.com" }),
    );
    expect(kept?.exception?.values?.[0]?.value).toBe(
      `Failed to load client ${REDACTED}`,
    );
  });

  it("scrubbing is not reimplemented here", () => {
    // Matched against CODE, not comments: the module header legitimately
    // discusses `redactString` when explaining why the decision is made on the
    // raw event. A guard that read the prose would pass or fail on wording.
    const code = codeOf(
      readFileSync(
        path.join(process.cwd(), "lib/observability/sentry-e2e-fault.ts"),
        "utf8",
      ),
    );
    expect(code).toContain("scrubErrorEvent(event)");
    expect(code).not.toContain("redactString");
    expect(code).not.toContain("deepScrub");
  });
});

describe("the canary never reaches the public client bundle", () => {
  it("the isomorphic scrub module carries no harness identity", () => {
    const src = codeOf(
      readFileSync(
        path.join(process.cwd(), "lib/observability/sentry-scrub.ts"),
        "utf8",
      ),
    );
    // ClientFault.tsx records why: the canary "is never compiled into the
    // production client bundle". sentry-scrub is imported by
    // instrumentation-client.ts, so a literal here ships to every visitor.
    expect(src).not.toContain("HONE-LEAK-CANARY");
    expect(src).not.toContain("e2e-fault");
    expect(src).not.toContain("E2E_ROUTE_FAULT");
  });

  it("the suppression module is server-only", () => {
    const src = readFileSync(
      path.join(process.cwd(), "lib/observability/sentry-e2e-fault.ts"),
      "utf8",
    );
    expect(src.startsWith('import "server-only";')).toBe(true);
  });

  it("the client config does not import the suppression module", () => {
    const src = codeOf(
      readFileSync(path.join(process.cwd(), "instrumentation-client.ts"), "utf8"),
    );
    expect(src).not.toContain("sentry-e2e-fault");
    expect(src).not.toContain("HONE-LEAK-CANARY");
  });

  it("no NEXT_PUBLIC bypass is introduced anywhere in this change", () => {
    for (const rel of [
      "lib/observability/sentry-e2e-fault.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
    ]) {
      const src = codeOf(readFileSync(path.join(process.cwd(), rel), "utf8"));
      expect(src, rel).not.toMatch(/NEXT_PUBLIC_[A-Z0-9_]*E2E/);
      expect(src, rel).not.toMatch(/NEXT_PUBLIC_[A-Z0-9_]*FAULT/);
    }
  });
});

describe("per-runtime beforeSend wiring", () => {
  const read = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8");

  it("sentry.server.config.ts wires the suppressing hook, scrub still authoritative", () => {
    const src = codeOf(read("sentry.server.config.ts"));
    expect(src).toContain("beforeSend: beforeSendWithE2eFaultSuppression");
    expect(src).toContain("@/lib/observability/sentry-e2e-fault");
    expect(src).toContain("@/lib/observability/sentry-scrub");
    expect(src).toContain("beforeSendTransaction: scrubTransactionEvent");
    expect(src).toContain("beforeBreadcrumb: scrubBreadcrumb");
  });

  for (const file of ["instrumentation-client.ts", "sentry.edge.config.ts"]) {
    it(`${file} wires scrubErrorEvent directly and fails open`, () => {
      const src = codeOf(read(file));
      expect(src).toContain("beforeSend: scrubErrorEvent");
      // Neither runtime may reach the server-only suppression module: the
      // client cannot without a NEXT_PUBLIC_* bypass, and edge is deliberately
      // not wired because no synthetic event originates there and its
      // process.env reachability for this variable is unverified.
      expect(src).not.toContain("sentry-e2e-fault");
      expect(src).not.toContain("beforeSendWithE2eFaultSuppression");
    });
  }
});

describe("logentry.message is an EXPLICIT part of marker matching", () => {
  it("drops a synthetic fault whose canary arrives only in logentry.message", () => {
    // Sentry populates the logentry interface instead of `message` for some
    // captures. Excluding it would make the drop depend on which capture path
    // fired, so it is matched deliberately.
    const event = {
      logentry: { message: HARNESS_MESSAGE },
    } as unknown as ErrorEvent;
    expect(isDeliberateE2eFaultEvent(event, HARNESS_ON)).toBe(true);
  });

  it("but logentry alone cannot suppress in production (context still required)", () => {
    const event = {
      logentry: { message: HARNESS_MESSAGE },
    } as unknown as ErrorEvent;
    expect(isDeliberateE2eFaultEvent(event, HARNESS_OFF)).toBe(false);
  });

  it("a non-string logentry.message is ignored without throwing", () => {
    const event = {
      logentry: { message: { nested: HARNESS_MESSAGE } },
    } as unknown as ErrorEvent;
    expect(isDeliberateE2eFaultEvent(event, HARNESS_ON)).toBe(false);
  });
});

describe("harness context comes from the SERVER ENV, never from the request", () => {
  // The audit's first recommendation: prove the positive mechanism cannot be
  // supplied by attacker/request-controlled input. Every field below is
  // request- or payload-derived, and none of them may enable suppression.
  const adversarial: Array<[string, Record<string, unknown>]> = [
    ["tags", { tags: { HONE_E2E_ROUTE_FAULT: "1" } }],
    ["extra", { extra: { HONE_E2E_ROUTE_FAULT: "1" } }],
    ["contexts", { contexts: { runtime: { HONE_E2E_ROUTE_FAULT: "1" } } }],
    ["request headers", { request: { headers: { "x-hone-e2e-route-fault": "1" } } }],
    ["request cookies", { request: { cookies: "HONE_E2E_ROUTE_FAULT=1" } }],
    ["request query", { request: { query_string: "HONE_E2E_ROUTE_FAULT=1" } }],
    ["request url", { request: { url: "https://hone.care/?HONE_E2E_ROUTE_FAULT=1" } }],
    ["user", { user: { id: "HONE_E2E_ROUTE_FAULT=1" } }],
    ["transaction", { transaction: "/e2e-fault/[case]?HONE_E2E_ROUTE_FAULT=1" }],
  ];

  for (const [label, extra] of adversarial) {
    it(`${label} cannot enable suppression`, () => {
      const event = {
        exception: { values: [{ type: "Error", value: HARNESS_MESSAGE }] },
        ...extra,
      } as unknown as ErrorEvent;
      // Canary present, harness genuinely OFF: the event must survive.
      expect(isDeliberateE2eFaultEvent(event, HARNESS_OFF), label).toBe(false);
    });
  }

  it("the gate variable is server-only, never NEXT_PUBLIC_", () => {
    const raw = readFileSync(
      path.join(process.cwd(), "lib/reliability/e2e-route-fault.ts"),
      "utf8",
    );
    const guard = codeOf(raw);
    expect(guard).toContain("HONE_E2E_ROUTE_FAULT");
    expect(guard).not.toContain("NEXT_PUBLIC_HONE_E2E_ROUTE_FAULT");
    expect(raw.startsWith('import "server-only";')).toBe(true);
  });

  it("the harness's own activation invariant is REUSED, not re-derived", () => {
    const code = codeOf(
      readFileSync(
        path.join(process.cwd(), "lib/observability/sentry-e2e-fault.ts"),
        "utf8",
      ),
    );
    expect(code).toContain("isE2eRouteFaultEnabled(env)");
    // A second copy of the law would be free to drift from the one that
    // actually gates the harness.
    expect(code).not.toContain("HONE_E2E_ROUTE_FAULT");
    expect(code).not.toContain("VERCEL");
    expect(code).not.toContain("KUBERNETES");
  });
});

describe("the client bundle cannot reach server-only state through shared imports", () => {
  const read = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8");

  it("the module the client DOES import pulls in no harness module", () => {
    // instrumentation-client.ts imports sentry-scrub. If sentry-scrub imported
    // the guard or the suppression module, `server-only` state would be dragged
    // into the client graph and the canary would ship publicly again.
    // CODE, not prose: sentry-scrub's header legitimately says it has "no
    // server-only imports", and a guard reading the comment would invert.
    const scrub = codeOf(read("lib/observability/sentry-scrub.ts"));
    expect(scrub).not.toContain("e2e-route-fault");
    expect(scrub).not.toContain("sentry-e2e-fault");
    expect(scrub).not.toContain("server-only");
  });

  it("the client's own import list names no harness module", () => {
    const client = read("instrumentation-client.ts");
    const imports = client.match(/from\s+"[^"]+"/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) {
      expect(imp).not.toContain("e2e-route-fault");
      expect(imp).not.toContain("sentry-e2e-fault");
      expect(imp).not.toContain("reliability");
    }
  });
});

describe("the predicate is pure and total", () => {
  it("handles an empty event", () => {
    expect(isDeliberateE2eFaultEvent({} as unknown as ErrorEvent, HARNESS_ON)).toBe(false);
  });

  it("does not mutate the event when deciding", () => {
    const event = errorEvent({ value: HARNESS_MESSAGE });
    const before = JSON.stringify(event);
    isDeliberateE2eFaultEvent(event, HARNESS_ON);
    expect(JSON.stringify(event)).toBe(before);
  });
});
