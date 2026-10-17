import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";

import { scrubBreadcrumb, scrubErrorEvent, scrubTransactionEvent } from "@/lib/observability/sentry-scrub";
import { TOKEN_PLACEHOLDER } from "@/lib/security/token-routes";

// ===========================================================================
// #828 G-25 (part of G-26): clinical and booking record ids never reach
// Sentry.
//
// Hone addresses clients, sessions, appointments, intake forms and studios by
// UUID. Production kept them in every Sentry surface: request.url, the
// transaction name (the grouping key), exception messages, breadcrumbs and
// span descriptions or attributes, so "/clients/<uuid>" left the app.
//
// Every value below is SYNTHETIC. The canary sweep serialises each scrubbed
// event and asserts that none of the record ids survives anywhere, while the
// route shape ("/clients/[id]") and Sentry's own dashless correlation ids are
// kept.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const APPT = "ABCDEF12-3456-4789-8ABC-DEF012345678"; // upper case: matched case-insensitively
const STUDIO = "11111111-2222-4333-8444-555555555555";
const IDS = [CLIENT, SESSION, APPT, STUDIO];

// Sentry's own correlation ids are dashless hex: they must survive.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const EVENT_ID = "9f2c5e1d7a6b4c3e8f0a1b2c3d4e5f60";

function expectNoRecordId(value: unknown, where: string): void {
  const json = JSON.stringify(value).toLowerCase();
  for (const id of IDS) expect(json, `${where} still carries ${id}`).not.toContain(id.toLowerCase());
}

function errorEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: undefined, event_id: EVENT_ID, ...over } as ErrorEvent;
}

describe("G-25: record ids are removed from every Sentry error-event surface", () => {
  it("request.url, transaction, message and exception keep the route shape but lose the ids", () => {
    const out = scrubErrorEvent(
      errorEvent({
        message: `Failed to load session ${SESSION} for client ${CLIENT}`,
        transaction: `GET /clients/${CLIENT}/sessions/${SESSION}`,
        request: { url: `https://hone.care/clients/${CLIENT}/sessions/${SESSION}?tab=photos#top` },
        exception: { values: [{ type: "Error", value: `appointment ${APPT} not found in studio ${STUDIO}` }] },
      }),
    );
    expectNoRecordId(out, "error event");
    expect(out.request?.url).toBe("https://hone.care/clients/[id]/sessions/[id]");
    expect(out.transaction).toBe("GET /clients/[id]/sessions/[id]");
    expect(out.message).toBe("Failed to load session [id] for client [id]");
    expect(out.exception?.values?.[0]?.value).toBe("appointment [id] not found in studio [id]");
  });

  it("extra, tags, contexts and user lose record ids, at any depth", () => {
    const out = scrubErrorEvent(
      errorEvent({
        extra: { route: `/calendar/${APPT}`, nested: { list: [`/clients/${CLIENT}`] } },
        tags: { page: `/sessions/${SESSION}` },
        contexts: { app: { app_start: `studio ${STUDIO}` }, custom: { record: `/clients/${CLIENT}` } },
        user: { id: CLIENT },
      }),
    );
    expectNoRecordId(out, "extra/tags/contexts/user");
  });

  it("logentry message and params, and a custom fingerprint, lose record ids (Codex P1 4301281977, 4301447093)", () => {
    const out = scrubErrorEvent(
      errorEvent({
        logentry: {
          message: `Failed to load client ${CLIENT}`,
          formatted: `Failed to load client ${CLIENT} in studio ${STUDIO}`,
          params: [SESSION, { appt: APPT }],
        },
        fingerprint: ["{{ default }}", `/clients/${CLIENT}`],
      } as Partial<ErrorEvent>),
    );
    expectNoRecordId(out, "logentry/fingerprint");
    expect(out.logentry?.message).toBe("Failed to load client [id]");
    expect((out.logentry as { formatted?: string }).formatted).toBe("Failed to load client [id] in studio [id]");
    expect(out.fingerprint).toEqual(["{{ default }}", "/clients/[id]"]);
  });

  it("structured exception and thread payloads lose record ids, frames stay symbolicable (Codex P1, review 5556246142)", () => {
    const chunk = "app:///_next/static/chunks/app/1234567890123-abcdef.js";
    const out = scrubErrorEvent(
      errorEvent({
        exception: {
          values: [
            {
              type: `ClientLoad_${CLIENT}`,
              value: "boom",
              mechanism: { type: "generic", handled: true, data: { session: SESSION, [APPT]: "k" } },
              stacktrace: {
                frames: [
                  { filename: chunk, lineno: 12, colno: 3 },
                  { filename: `/clients/${CLIENT}/page.js`, context_line: `load("${STUDIO}")`, vars: { id: APPT } },
                ],
              },
            },
          ],
        },
        threads: { values: [{ id: 1, stacktrace: { frames: [{ abs_path: `https://hone.care/clients/${CLIENT}` }] } }] },
      } as Partial<ErrorEvent>),
    );
    expectNoRecordId(out, "exception structure / threads");
    const frames = out.exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames[0]).toEqual({ filename: chunk, lineno: 12, colno: 3 });
    expect(frames[1]?.filename).toBe("/clients/[id]/page.js");
    expect(out.exception?.values?.[0]?.type).toBe("ClientLoad_[id]");
  });

  it("keeps Sentry's own dashless correlation ids (event, trace, span)", () => {
    const out = scrubErrorEvent(
      errorEvent({
        contexts: { trace: { trace_id: TRACE_ID, span_id: SPAN_ID } },
        transaction: `GET /clients/${CLIENT}`,
      }),
    );
    expect(out.event_id).toBe(EVENT_ID);
    expect((out.contexts?.trace as Record<string, unknown>).trace_id).toBe(TRACE_ID);
    expect((out.contexts?.trace as Record<string, unknown>).span_id).toBe(SPAN_ID);
  });

  it("still canonicalizes a token route to [Redacted] first (F-PRIV-001 unchanged)", () => {
    const out = scrubErrorEvent(errorEvent({ request: { url: `https://hone.care/intake/${CLIENT}` } }));
    expect(out.request?.url).toBe(`https://hone.care/intake/${TOKEN_PLACEHOLDER}`);
  });
});

describe("G-25: breadcrumbs and spans", () => {
  it("navigation and fetch breadcrumbs lose record ids (message, url, from, to)", () => {
    const nav = scrubBreadcrumb({
      category: "navigation",
      data: { from: `/clients/${CLIENT}`, to: `/calendar/${APPT}` },
    } as Breadcrumb);
    const fetchCrumb = scrubBreadcrumb({
      category: "fetch",
      message: `GET /rest/v1/sessions?id=eq.${SESSION}`,
      data: { url: `https://db.example.test/rest/v1/sessions?id=eq.${SESSION}`, method: "GET", status_code: 200 },
    } as Breadcrumb);
    expectNoRecordId(nav, "navigation breadcrumb");
    expectNoRecordId(fetchCrumb, "fetch breadcrumb");
    expect(nav?.data?.from).toBe("/clients/[id]");
    expect(fetchCrumb?.data?.status_code).toBe(200);
  });

  it("transaction events lose record ids in span descriptions and span data", () => {
    const out = scrubTransactionEvent({
      type: "transaction",
      transaction: `GET /clients/${CLIENT}`,
      contexts: { trace: { trace_id: TRACE_ID, span_id: SPAN_ID } },
      spans: [
        { description: `select * from sessions where id = '${SESSION}'`, data: { "db.statement": `... '${APPT}'` } },
        { description: `GET https://db.example.test/rest/v1/clients?id=eq.${CLIENT}`, data: { "http.url": `https://db.example.test/rest/v1/clients?id=eq.${CLIENT}` } },
      ] as unknown as Event["spans"],
    } as Event);
    expectNoRecordId(out, "transaction event");
    expect(out.transaction).toBe("GET /clients/[id]");
    expect((out.contexts?.trace as Record<string, unknown>).trace_id).toBe(TRACE_ID);
  });
});

describe("G-25: record ids as object KEYS (Codex P2 4301012675)", () => {
  it("removes ids used as property names at any depth, in every scrubbed map", () => {
    const out = scrubErrorEvent(
      errorEvent({
        extra: { [CLIENT]: "failed", nested: { [SESSION]: { [APPT]: 1 } } },
        tags: { [STUDIO]: "x" },
        contexts: { [CLIENT]: { state: "stale" }, custom: { [SESSION]: true } },
        request: { url: "https://hone.care/dashboard", data: { [APPT]: "body" } },
        user: { [STUDIO]: "member" } as unknown as ErrorEvent["user"],
      }),
    );
    expectNoRecordId(out, "keys in extra/tags/contexts/request/user");
    expect((out.extra as Record<string, unknown>)["[id]"]).toBe("failed");
  });

  it("keeps both values when two id keys collapse to the same name", () => {
    const out = scrubErrorEvent(errorEvent({ extra: { [CLIENT]: "a", [SESSION]: "b" } }));
    expect(out.extra).toEqual({ "[id]": "a", "[id]#2": "b" });
  });

  it("keeps every value when a literal placeholder key follows a scrubbed one, in either order (Codex P2 4301073939)", () => {
    const after = scrubErrorEvent(errorEvent({ extra: { [CLIENT]: "a", "[id]": "b", "[id]#2": "c" } }));
    expect(Object.values(after.extra as Record<string, unknown>).sort()).toEqual(["a", "b", "c"]);
    const before = scrubErrorEvent(errorEvent({ extra: { "[id]": "b", [CLIENT]: "a" } }));
    expect(Object.values(before.extra as Record<string, unknown>).sort()).toEqual(["a", "b"]);
    expectNoRecordId(after, "collision keys");
  });

  it("leaves ordinary keys named like Object.prototype members unchanged (Codex P2 4301342389)", () => {
    const extra = JSON.parse('{"constructor":"a","toString":"b","hasOwnProperty":"c","valueOf":"d"}');
    const out = scrubErrorEvent(errorEvent({ extra }));
    expect(Object.keys(out.extra as object).sort()).toEqual(["constructor", "hasOwnProperty", "toString", "valueOf"]);
  });

  it("removes id keys in breadcrumb data and span data", () => {
    const crumb = scrubBreadcrumb({ category: "app", data: { [CLIENT]: { [SESSION]: "x" } } } as Breadcrumb);
    const tx = scrubTransactionEvent({
      type: "transaction",
      spans: [{ description: "load", data: { [APPT]: "row" } }] as unknown as Event["spans"],
    } as Event);
    expectNoRecordId(crumb, "breadcrumb data keys");
    expectNoRecordId(tx, "span data keys");
  });
});

describe("G-25: ids inside compound identifiers (Codex P2 4301012678)", () => {
  it("removes a UUID joined to letters, digits or underscores", () => {
    const out = scrubErrorEvent(
      errorEvent({
        message: `event hone_booking_${APPT} for client_${CLIENT}_x and z${SESSION}q`,
        tags: { key: `studio${STUDIO}` },
      }),
    );
    expectNoRecordId(out, "compound identifiers");
    expect(out.message).toBe("event hone_booking_[id] for client_[id]_x and z[id]q");
  });

  it("removes a UUID whose hyphens are percent-encoded, in either case (Codex P2 4301149388)", () => {
    const upper = CLIENT.replace(/-/g, "%2D");
    const lower = SESSION.replace(/-/g, "%2d");
    const mixed = APPT.replace("-", "%2D");
    const out = scrubErrorEvent(
      errorEvent({
        request: { url: `https://hone.care/clients/${upper}/sessions/${lower}` },
        message: `load ${mixed} failed`,
        extra: { [upper]: "key" },
      }),
    );
    const json = JSON.stringify(out).toLowerCase();
    for (const id of [upper, lower, mixed]) expect(json).not.toContain(id.toLowerCase());
    expect(out.request?.url).toBe("https://hone.care/clients/[id]/sessions/[id]");
    expect(out.message).toBe("load [id] failed");
  });

  it("does not touch a longer hex run that is not a UUID", () => {
    const notUuid = `a${CLIENT.replace(/-/g, "")}ff`; // dashless hex, like Sentry's own ids
    const out = scrubErrorEvent(errorEvent({ message: `trace ${notUuid}` }));
    expect(out.message).toBe(`trace ${notUuid}`);
  });
});

describe("G-25: the final whole-event sweep (backstop for fields no pass lists)", () => {
  it("removes a record id from any field, including ones Sentry may add later", () => {
    const out = scrubErrorEvent(
      errorEvent({
        server_name: `worker-${CLIENT}`,
        dist: SESSION,
        modules: { [`pkg-${APPT}`]: "1.0.0" },
        debug_meta: { images: [{ code_file: `/srv/${STUDIO}/chunk.js` }] },
        future_field: { nested: [{ deep: { deeper: `/clients/${CLIENT}` } }] },
      } as unknown as Partial<ErrorEvent>),
    );
    expectNoRecordId(out, "whole-event sweep");
    expect(out.event_id).toBe(EVENT_ID);
  });

  it("keeps sdkProcessingMetadata verbatim: internal, never sent (Codex P2 4301513265)", () => {
    class FakeScope {
      tag = `scope-${CLIENT}`;
    }
    const scope = new FakeScope();
    const meta = { capturedSpanScope: scope, normalizedRequest: { url: `/clients/${CLIENT}` } };
    const out = scrubTransactionEvent({
      type: "transaction",
      transaction: `GET /clients/${CLIENT}`,
      sdkProcessingMetadata: meta,
    } as unknown as Event);
    expect(out.sdkProcessingMetadata).toBe(meta);
    expect((out.sdkProcessingMetadata as unknown as typeof meta).capturedSpanScope).toBe(scope);
    const wire = { ...out, sdkProcessingMetadata: undefined };
    expectNoRecordId(wire, "wire payload beside sdkProcessingMetadata");
  });

  it("keeps a deep but legitimate transaction structure intact", () => {
    const out = scrubTransactionEvent({
      type: "transaction",
      contexts: { trace: { trace_id: TRACE_ID, span_id: SPAN_ID } },
      spans: [{ description: "load", data: { a: { b: { c: 1 } } } }] as unknown as Event["spans"],
    } as Event);
    expect((out.spans as unknown as Array<{ data: unknown }>)[0]?.data).toEqual({ a: { b: { c: 1 } } });
    expect((out.contexts?.trace as Record<string, unknown>).trace_id).toBe(TRACE_ID);
  });
});
