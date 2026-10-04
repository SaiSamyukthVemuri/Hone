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
// Every negative test below is an error class whose SYNTHETIC twin this change
// drops. They are the point of the file: suppression keyed on the class rather
// than on harness identity would hide each of these real defects.

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

  it("the canary still carries the generic Postgres text, so the negatives are real", () => {
    // If this ever stopped being true, test 3 below would be vacuous: it proves
    // the SAME text without harness identity survives.
    expect(E2E_ROUTE_FAULT_CANARY).toContain('relation "clients" does not exist');
  });
});

describe("1. synthetic SERVER throw is dropped", () => {
  it("drops the server-component throw carrying the canary", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      transaction: "/e2e-fault/[case]",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(true);
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops it on marker alone, with no route identity at all", () => {
    const event = errorEvent({ value: HARNESS_MESSAGE });
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops a message-only event carrying the marker", () => {
    const event = errorEvent({ message: HARNESS_MESSAGE });
    expect(scrubErrorEvent(event)).toBeNull();
  });
});

describe("2. synthetic CLIENT throw / canary is dropped", () => {
  it("drops the browser throw (same canary, arrives as a prop)", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      url: "http://localhost:3111/e2e-fault/client-throw",
    });
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops a synthetic event whose message React elided, via route identity", () => {
    // A production build replaces a server error's message, so the marker is
    // gone. Route identity is what still proves origin.
    const event = errorEvent({
      value: "An error occurred in the Server Components render.",
      url: "http://localhost:3111/e2e-fault/server-throw?token=abc",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(true);
    expect(scrubErrorEvent(event)).toBeNull();
  });

  it("drops the `once` case with its per-visit token", () => {
    const event = errorEvent({
      value: HARNESS_MESSAGE,
      url: "http://localhost:3111/e2e-fault/once?token=t-1",
      transaction: "/e2e-fault/[case]",
    });
    expect(scrubErrorEvent(event)).toBeNull();
  });
});

describe("3. the SAME Postgres text without harness identity is KEPT", () => {
  it('keeps `relation "clients" does not exist` from a real loader', () => {
    const event = errorEvent({
      value: 'Failed to load clients: relation "clients" does not exist',
      transaction: "/clients",
      url: "https://hone.care/clients",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    const kept = scrubErrorEvent(event);
    expect(kept).not.toBeNull();
    expect(kept?.exception?.values?.[0]?.value).toContain(
      'relation "clients" does not exist',
    );
  });

  it("keeps the harness message with ONLY the marker removed (non-vacuity)", () => {
    // Identical to test 1's event except the identity. If suppression keyed on
    // the Postgres text, this would be dropped and the feature would be unsafe.
    const withoutMarker = HARNESS_MESSAGE.replace(` [${E2E_FAULT_MARKER}]`, "");
    expect(withoutMarker).not.toContain(E2E_FAULT_MARKER);
    const event = errorEvent({ value: withoutMarker, transaction: "/clients" });
    expect(scrubErrorEvent(event)).not.toBeNull();
  });

  it("does not treat a nested or differently-rooted path as the harness", () => {
    for (const url of [
      "https://hone.care/e2e-fault",
      "https://hone.care/e2e-fault/a/b",
      "https://hone.care/x/e2e-fault/server-throw",
      "https://hone.care/dashboard",
    ]) {
      const event = errorEvent({ value: "boom", url });
      expect(scrubErrorEvent(event), url).not.toBeNull();
    }
  });
});

describe("4. ordinary production-like exceptions are KEPT", () => {
  const realistic: Array<[string, Partial<Parameters<typeof errorEvent>[0]>]> = [
    ["cookies() misuse", { value: "`cookies()` was called outside a request scope." }],
    ["after() misuse", { value: "`after()` was called outside a request scope." }],
    ["no practitioner", { value: "No active practitioner found" }],
    ["network", { value: "Failed to fetch", type: "TypeError" }],
    ["server action", { value: "Failed Server Action" }],
    ["TypeError", { value: "Cannot read properties of undefined (reading 'id')", type: "TypeError" }],
    ["500", { value: "Request failed with status code 500" }],
    ["generic postgres", { value: 'relation "sessions" does not exist' }],
  ];

  for (const [label, parts] of realistic) {
    it(`keeps: ${label}`, () => {
      const event = errorEvent({ transaction: "/dashboard", ...parts });
      expect(isDeliberateE2eFaultEvent(event), label).toBe(false);
      expect(scrubErrorEvent(event), label).not.toBeNull();
    });
  }
});

describe("5. the privacy scrub still runs for KEPT events", () => {
  it("redacts an email in a kept event's exception value", () => {
    const event = errorEvent({
      value: "Failed to load client jane.doe@example.com",
      transaction: "/clients",
    });
    const kept = scrubErrorEvent(event);
    expect(kept).not.toBeNull();
    expect(kept?.exception?.values?.[0]?.value).toBe(
      `Failed to load client ${REDACTED}`,
    );
  });

  it("redacts a JWT in a kept event's message", () => {
    const event = errorEvent({
      message: "auth failed eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      transaction: "/dashboard",
    });
    const kept = scrubErrorEvent(event);
    expect(kept?.message).toBe(`auth failed ${REDACTED}`);
  });
});

describe("6. the beforeSend wiring is unchanged in all three runtimes", () => {
  const root = process.cwd();
  const configs = [
    "instrumentation-client.ts",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
  ];

  for (const file of configs) {
    it(`${file} still wires beforeSend: scrubErrorEvent`, () => {
      const src = readFileSync(path.join(root, file), "utf8");
      expect(src).toContain("beforeSend: scrubErrorEvent");
      expect(src).toContain("scrubErrorEvent");
      // No per-config suppression: the decision lives in ONE module.
      expect(src).not.toContain("e2e-fault");
      expect(src).not.toContain(E2E_FAULT_MARKER);
    });
  }
});

describe("FAIL CLOSED: the deployment-guard alarm is never suppressed", () => {
  it("keeps the guard throw even though it is raised ON the harness route", () => {
    // assertRouteFaultNotRequestedInDeployment exists so a misconfiguration
    // "surfaces immediately". Route identity alone would silence it.
    const event = errorEvent({
      value:
        "HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (VERCEL).",
      transaction: "/e2e-fault/[case]",
      url: "https://hone.care/e2e-fault/server-throw",
    });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });

  it("keeps it even if the canary is also present", () => {
    const event = errorEvent({
      value: `HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (VERCEL_ENV=production). ${E2E_ROUTE_FAULT_CANARY}`,
      transaction: "/e2e-fault/[case]",
    });
    expect(scrubErrorEvent(event)).not.toBeNull();
  });
});

describe("the predicate is pure and total", () => {
  it("handles an empty event without throwing", () => {
    const event = {} as unknown as ErrorEvent;
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
    expect(scrubErrorEvent(event)).not.toBeNull();
  });

  it("handles a malformed url without throwing", () => {
    const event = errorEvent({ value: "boom", url: "not a url" });
    expect(isDeliberateE2eFaultEvent(event)).toBe(false);
  });

  it("does not mutate the event when deciding", () => {
    const event = errorEvent({ value: HARNESS_MESSAGE, transaction: "/e2e-fault/[case]" });
    const before = JSON.stringify(event);
    isDeliberateE2eFaultEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});
