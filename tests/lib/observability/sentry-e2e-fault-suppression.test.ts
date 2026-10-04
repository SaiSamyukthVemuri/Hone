import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  E2E_FAULT_MARKER,
  isDeliberateE2eFaultEvent,
  scrubErrorEvent,
} from "@/lib/observability/sentry-scrub";
import { E2E_ROUTE_FAULT_CANARY } from "@/lib/reliability/e2e-route-fault";

// SENTRY-NOISE-01. The deliberate fault harness must not post into the
// operational Sentry queue, and NOTHING ELSE may be suppressed with it.
//
// THE MARKER IS THE WHOLE IDENTITY. The harness ROUTE is deliberately not an
// identity: an unexpected TypeError, a `cookies()` misuse or a framework
// regression can be raised on `/e2e-fault/<case>` just as anywhere else, and
// route-based suppression would silence every one of them. Tests 3-5 are that
// rule, and the mutation proof in the commit message shows they go red the
// moment a route fallback is restored.

const REDACTED = "[Redacted]";

/** The exact string the harness throws (page.tsx builds this). */
const HARNESS_MESSAGE = `Failed to load fault fixture: ${E2E_ROUTE_FAULT_CANARY}`;

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

describe("the marker cannot drift from the harness", () => {
  it("E2E_FAULT_MARKER is the token embedded in E2E_ROUTE_FAULT_CANARY", () => {
    expect(E2E_ROUTE_FAULT_CANARY).toContain(E2E_FAULT_MARKER);
    expect(E2E_FAULT_MARKER).toBe("HONE-LEAK-CANARY-9f3c1d");
  });

  it("the canary still carries the generic Postgres text, so test 6 is real", () => {
    expect(E2E_ROUTE_FAULT_CANARY).toContain('relation "clients" does not exist');
  });
});

describe("1. the exact canary marker is DROPPED", () => {
  it("drops the server-component throw carrying the canary", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      transaction: "/e2e-fault/[case]",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(true);
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops on the marker alone, with no route information at all", () => {
    expect(scrubErrorEvent(errorEvent({ value: HARNESS_MESSAGE }))).toBeNull();
  });

  it("drops a message-only event carrying the marker", () => {
    expect(scrubErrorEvent(errorEvent({ message: HARNESS_MESSAGE }))).toBeNull();
  });
});

describe("2. the exact canary on a CLIENT synthetic event is DROPPED", () => {
  it("drops the browser throw (same canary, arrives as a prop)", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      url: "http://localhost:3141/e2e-fault/client-throw",
    });
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops the `once` case with its per-visit token", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      url: "http://localhost:3141/e2e-fault/once?token=t-1",
      transaction: "/e2e-fault/[case]",
    });
    expect(scrubErrorEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3-5. THE HARNESS ROUTE IS NOT AN IDENTITY.
// Each event below happens ON the harness route and carries NO marker. Every
// one is a genuine defect the operator must see.
// ---------------------------------------------------------------------------

describe("3. /e2e-fault/ok + unexpected TypeError, no marker => KEPT", () => {
  it("keeps it", () => {
    const event = errorEvent({
      value: "Cannot read properties of undefined (reading 'token')",
      type: "TypeError",
      transaction: "/e2e-fault/[case]",
      url: "http://localhost:3141/e2e-fault/ok",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });
});

describe("4. /e2e-fault/server-throw + unrelated TypeError, no marker => KEPT", () => {
  it("keeps it", () => {
    const event = errorEvent({
      value: "x.map is not a function",
      type: "TypeError",
      transaction: "/e2e-fault/[case]",
      url: "http://localhost:3141/e2e-fault/server-throw",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });
});

describe("5. /e2e-fault/server-throw + React production-elision text => KEPT", () => {
  it("keeps it: the elided message proves nothing about intent", () => {
    // An earlier revision DROPPED exactly this, on route identity. It is kept
    // now: an elided message is indistinguishable from a real framework error
    // on the same route, so suppressing it would hide real failures. If the
    // marker is ever elided, the synthetic event simply becomes visible again.
    const event = errorEvent({
      value:
        "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
      transaction: "/e2e-fault/[case]",
      url: "http://localhost:3141/e2e-fault/server-throw",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });
});

describe("6-10. ordinary error classes are KEPT", () => {
  const cases: Array<[string, Parameters<typeof errorEvent>[0]]> = [
    ["6. generic relation \"clients\" does not exist", {
      value: 'Failed to load clients: relation "clients" does not exist',
      transaction: "/clients",
    }],
    ["6b. generic relation \"sessions\" does not exist", {
      value: 'relation "sessions" does not exist',
      transaction: "/clients",
    }],
    ["7. cookies() outside request scope", {
      value: "`cookies()` was called outside a request scope.",
      transaction: "/dashboard",
    }],
    ["7b. after() outside request scope", {
      value: "`after()` was called outside a request scope.",
      transaction: "/dashboard",
    }],
    ["8. Failed to fetch", { value: "Failed to fetch", type: "TypeError", transaction: "/dashboard" }],
    ["9. No active practitioner found", { value: "No active practitioner found", transaction: "/dashboard" }],
    ["10. Failed Server Action", { value: "Failed Server Action", transaction: "/clients" }],
    ["10b. a 500", { value: "Request failed with status code 500", transaction: "/dashboard" }],
  ];

  for (const [label, parts] of cases) {
    it(`keeps: ${label}`, () => {
      const event = errorEvent(parts);
      expect(isDeliberateE2eFaultEvent(event), label).toBe(false);
      expect(scrubErrorEvent(event), label).not.toBeNull();
    });
  }

  it("keeps the harness message with ONLY the marker removed (non-vacuity)", () => {
    // Identical to test 1's event except the marker. If suppression keyed on
    // the Postgres text, this would be dropped and the feature would be unsafe.
    const withoutMarker = HARNESS_MESSAGE.replace(` [${E2E_FAULT_MARKER}]`, "");
    expect(withoutMarker).not.toContain(E2E_FAULT_MARKER);
    expect(
      scrubErrorEvent(errorEvent({ value: withoutMarker, transaction: "/e2e-fault/[case]" })),
    ).not.toBeNull();
  });
});

describe("11. the deployment-guard sentinel is KEPT", () => {
  it("keeps the guard throw raised ON the harness route", () => {
    const event = errorEvent({
      value:
        "HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (VERCEL).",
      transaction: "/e2e-fault/[case]",
      url: "https://hone.care/e2e-fault/server-throw",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });

  it("keeps it even if the canary somehow appears beside it", () => {
    const event = errorEvent({
      value: `HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (VERCEL_ENV=production). ${E2E_ROUTE_FAULT_CANARY}`,
      transaction: "/e2e-fault/[case]",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });
});

describe("12. KEPT events still run the privacy scrub", () => {
  it("redacts an email in a kept event's exception value", () => {
    const kept = scrubErrorEvent(
      errorEvent({
        value: "Failed to load client jane.doe@example.com",
        transaction: "/clients",
      }),
    );
    expect(kept).not.toBeNull();
    expect(kept?.exception?.values?.[0]?.value).toBe(
      `Failed to load client ${REDACTED}`,
    );
  });

  it("redacts a JWT in a kept event's message", () => {
    const kept = scrubErrorEvent(
      errorEvent({
        message: "auth failed eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
        transaction: "/dashboard",
      }),
    );
    expect(kept?.message).toBe(`auth failed ${REDACTED}`);
  });

  it("still scrubs an event kept ON the harness route", () => {
    const kept = scrubErrorEvent(
      errorEvent({
        value: "boom for jane.doe@example.com",
        type: "TypeError",
        url: "http://localhost:3141/e2e-fault/ok",
      }),
    );
    expect(kept).not.toBeNull();
    expect(kept?.exception?.values?.[0]?.value).toBe(`boom for ${REDACTED}`);
  });
});

describe("13. the beforeSend wiring is unchanged in all three runtimes", () => {
  const root = process.cwd();
  for (const file of [
    "instrumentation-client.ts",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
  ]) {
    it(`${file} still wires beforeSend: scrubErrorEvent`, () => {
      const src = readFileSync(path.join(root, file), "utf8");
      expect(src).toContain("beforeSend: scrubErrorEvent");
      // No per-config suppression: the decision lives in ONE module.
      expect(src).not.toContain("e2e-fault");
      expect(src).not.toContain(E2E_FAULT_MARKER);
    });
  }
});

describe("the predicate reads no route information at all", () => {
  it("ignores transaction and request.url entirely", () => {
    for (const parts of [
      { value: "boom", transaction: "/e2e-fault/[case]" },
      { value: "boom", url: "http://localhost:3141/e2e-fault/server-throw" },
      { value: "boom", url: "https://hone.care/e2e-fault/client-throw?token=x" },
    ]) {
      expect(isDeliberateE2eFaultEvent(errorEvent(parts))).toBe(false);
      expect(scrubErrorEvent(errorEvent(parts))).not.toBeNull();
    }
  });

  it("the module no longer carries route-matching machinery", () => {
    const src = readFileSync(
      path.join(process.cwd(), "lib/observability/sentry-scrub.ts"),
      "utf8",
    );
    expect(src).not.toContain("E2E_FAULT_PATHNAME_RE");
    expect(src).not.toContain("pathnameOf");
  });
});

describe("the predicate is pure and total", () => {
  it("handles an empty event without throwing", () => {
    const event = {} as unknown as ErrorEvent;
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });

  it("does not mutate the event when deciding", () => {
    const event = errorEvent({ value: HARNESS_MESSAGE });
    const before = JSON.stringify(event);
    isDeliberateE2eFaultEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});
