import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const boom = vi.hoisted(() => ({ on: false }));
vi.mock("@sentry/nextjs", async (orig) => {
  const actual = await orig<typeof import("@sentry/nextjs")>();
  return new Proxy(actual, {
    get: (t, k, r) => (k === "withIsolationScope" ? (cb: never) => (boom.on ? (() => { throw new Error("sdk exploded"); })() : t.withIsolationScope(cb)) : Reflect.get(t, k, r)),
  });
});import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubErrorEvent } from "@/lib/observability/sentry-scrub";
import { limiterOutageTags, reportLimiterOutage } from "@/lib/observability/limiter-outage-alert";

// DN-29 operator alert payload. The proof runs the REAL SDK (real serialisation, the runtime's own beforeSend and breadcrumb
// scrubbers) with a capturing transport, so what is asserted is the envelope that would have left the process. Sentinel
// values stand for everything that must never appear: an IP, an email, a studio slug, a hashed key, a token, a link.

const SENTINELS = ["203.0.113.250", "victim.person@harness.local", "studio-slug-sentinel", "deadbeefdeadbeefdeadbeefdeadbeef", "tok_SENTINEL_0123456789abcdef", "https://hone.example/manage/SENTINELTOKEN"];

const envelopes: unknown[] = [];

beforeAll(() => {
  Sentry.init({
    dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [],
    beforeSend: scrubErrorEvent, // the server runtime wires this (via the E2E-fault wrapper, which delegates to it)
    beforeBreadcrumb: scrubBreadcrumb,
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
});
afterEach(() => {
  envelopes.length = 0;
});

const good = { routeClass: "public_book", kind: "book", mode: "enforce", reason: "error", outcome: "refused_counter_unreachable", errorClass: "error", environment: "production" };

async function sent(): Promise<string> {
  await Sentry.flush(2000);
  return JSON.stringify(envelopes);
}

describe("limiter outage alert: closed values only", () => {
  it("POSITIVE CONTROL: a real event leaves with exactly the closed tag set and the fixed message", async () => {
    reportLimiterOutage(good);
    const wire = await sent();
    expect(envelopes.length).toBe(1);
    expect(wire).toContain("ratelimit_outage_fallback");
    for (const v of ["public_book", "refused_counter_unreachable", "production", "enforce"]) expect(wire).toContain(v);
    const event = (envelopes[0] as [unknown, [unknown, Record<string, unknown>][]])[1][0][1];
    expect(Object.keys(event.tags as object).sort()).toEqual(["deploy_env", "error_class", "event", "kind", "mode", "outcome", "reason", "route_class"]);
    expect(event.fingerprint).toEqual(["ratelimit_outage_fallback", "public_book", "refused_counter_unreachable"]);
    for (const absent of ["extra", "user", "request", "breadcrumbs", "contexts"]) {
      const v = event[absent] as Record<string, unknown> | unknown[] | undefined;
      expect(v === undefined || (Array.isArray(v) ? v.length === 0 : Object.keys(v).filter((k) => k !== "trace" && k !== "runtime" && k !== "os" && k !== "device" && k !== "culture").length === 0), absent).toBe(true);
    }
  });

  it("NEGATIVE: sentinel identifiers passed in EVERY field never reach the wire (they become 'other'/'unknown')", async () => {
    const hostile = Object.fromEntries(Object.keys(good).map((k, i) => [k, SENTINELS[i % SENTINELS.length]]));
    reportLimiterOutage(hostile as never);
    const wire = await sent();
    for (const s of SENTINELS) expect(wire).not.toContain(s);
    const tags = limiterOutageTags(hostile as never);
    expect(tags).toMatchObject({ route_class: "other", kind: "other", mode: "other", reason: "other", outcome: "other", deploy_env: "other" });
  });

  it("NEGATIVE: an errorClass is accepted only from the closed THROWN_ERROR_CLASSES list", async () => {
    for (const bad of [...SENTINELS, "error_with_extra_words", "deadbeef"]) expect(limiterOutageTags({ ...good, errorClass: bad }).error_class).toBe("none");
    expect(limiterOutageTags({ ...good, errorClass: "type_error" }).error_class).toBe("type_error");
  });

  it("NEGATIVE: sentinel text in the scope the SDK adds around the call (breadcrumbs, user, extra) is not part of the alert path", async () => {
    Sentry.getCurrentScope().setUser({ email: SENTINELS[1] });
    Sentry.getCurrentScope().setExtra("slug", SENTINELS[2]);
    Sentry.addBreadcrumb({ message: `GET ${SENTINELS[5]} from ${SENTINELS[0]}` });
    reportLimiterOutage(good);
    const wire = await sent();
    Sentry.getCurrentScope().clear();
    for (const s of [SENTINELS[0], SENTINELS[1], SENTINELS[2], SENTINELS[5]]) expect(wire, s).not.toContain(s);
  });

  it("never throws, even when the SDK does", () => {
    boom.on = true;
    try {
      expect(() => reportLimiterOutage(good)).not.toThrow();
    } finally {
      boom.on = false;
    }
  });
});
