import http from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ServerRuntimeClient,
  addBreadcrumb,
  captureException,
  createTransport,
  getCurrentScope,
  getIsolationScope,
  setCurrentClient,
  startSpan,
  withScope,
  type BaseTransportOptions,
  type Transport,
} from "@sentry/core";

import { scrubBreadcrumb, scrubErrorEvent, scrubTransactionEvent } from "@/lib/observability/sentry-scrub";

// ===========================================================================
// #828 G-08: what the Sentry SDK actually SERIALIZES, after Hone's scrubbers.
//
// The scrubber tests (sentry-record-ids, sentry-token-paths) check the object
// beforeSend returns. This file checks the BYTES the transport is handed: the
// envelope header (its `trace` field is built from the dynamic sampling
// context AFTER beforeSend), every item header and every payload. The real
// @sentry/core client runs with the scrubbers wired exactly as
// sentry.*.config.ts wire them; the transport is in memory.
//
// ZERO NETWORK: a dummy DSN (never Hone's real one, which reports to the
// production project), an in-memory transport, and fetch / http(s).request
// stubbed to throw and asserted never called. All ids are SYNTHETIC.
//
// NEGATIVE CONTROL: the same capture with the scrubbers unset leaks the ids.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const APPT = "ABCDEF12-3456-4789-8ABC-DEF012345678";
const STUDIO = "11111111-2222-4333-8444-555555555555";
const DUMMY_DSN = "https://publickey@o1.ingest.example.invalid/1";

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The #891 oracle: decode ASCII percent-escapes to a fixed point. */
function oracleDecode(text: string): string {
  let cur = text;
  for (let i = 0; i < 16; i += 1) {
    const next = cur.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

const networkCalls: string[] = [];
beforeAll(() => {
  vi.stubGlobal("fetch", (input: unknown) => {
    networkCalls.push(`fetch ${String(input)}`);
    throw new Error("network egress is forbidden in this test");
  });
  vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
    networkCalls.push(`http.request ${JSON.stringify(args[0])}`);
    throw new Error("network egress is forbidden in this test");
  }) as typeof http.request);
  vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
    networkCalls.push(`https.request ${JSON.stringify(args[0])}`);
    throw new Error("network egress is forbidden in this test");
  }) as typeof https.request);
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterEach(() => {
  getCurrentScope().clear();
  getIsolationScope().clear();
});

/** A client whose transport records each serialized envelope in memory. */
function makeClient(scrubbed: boolean): { client: ServerRuntimeClient; sent: string[] } {
  const sent: string[] = [];
  const transport = (options: BaseTransportOptions): Transport =>
    createTransport(options, async (request) => {
      const body = request.body;
      sent.push(typeof body === "string" ? body : new TextDecoder().decode(body));
      return { statusCode: 200 };
    });
  const client = new ServerRuntimeClient({
    dsn: DUMMY_DSN,
    environment: "test",
    release: "g08-test",
    sendDefaultPii: false,
    tracesSampleRate: 1,
    integrations: [],
    stackParser: () => [],
    transport,
    ...(scrubbed
      ? { beforeSend: scrubErrorEvent, beforeSendTransaction: scrubTransactionEvent, beforeBreadcrumb: scrubBreadcrumb }
      : {}),
  });
  setCurrentClient(client);
  client.init();
  return { client, sent };
}

/** One error inside a transaction on an id-bearing route, with breadcrumbs,
 *  tags, extra and a percent-encoded URL, then a flush. */
async function driveJourney(client: ServerRuntimeClient): Promise<void> {
  const route = `/clients/${CLIENT}/sessions/${SESSION}`;
  addBreadcrumb({ category: "navigation", data: { from: `/calendar/${APPT}`, to: route } });
  addBreadcrumb({
    category: "fetch",
    message: `GET /rest/v1/clients?id=eq.${CLIENT}`,
    data: { url: `https://db.example.invalid/rest/v1/sessions?id=eq.${SESSION}`, status_code: 500 },
  });
  await startSpan(
    {
      name: `GET ${route}`,
      forceTransaction: true,
      op: "http.server",
      attributes: {
        "sentry.source": "route",
        "http.url": `https://hone.example.invalid/clients/${CLIENT.replace(/-/g, "%2D")}/sessions/%36${SESSION.slice(1)}`,
        "studio.id": STUDIO,
      },
    },
    async () => {
      await startSpan({ name: `select sessions where id = '${SESSION}'`, op: "db" }, async () => undefined);
      withScope((scope) => {
        scope.setTag("page", route);
        scope.setExtra("appointment", `/calendar/${APPT}`);
        scope.setContext("record", { client: CLIENT, [STUDIO]: "key" });
        captureException(new Error(`load failed for client ${CLIENT} in studio ${STUDIO}`));
      });
    },
  );
  await client.flush(2000);
}

describe("G-08: the serialized Sentry envelopes carry no record id", () => {
  it("error, transaction and breadcrumbs: no UUID in any envelope header, item header or payload, in any encoding", async () => {
    const { client, sent } = makeClient(true);
    await driveJourney(client);

    // The journey really produced an error envelope and a transaction envelope,
    // and the envelope header's trace context (built after beforeSend) was sent.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const all = sent.join("\n");
    expect(all).toContain('"type":"event"');
    expect(all).toContain('"type":"transaction"');
    // The envelope HEADER's trace context (from the DSC, built after
    // beforeSend) names the route with the ids removed.
    const headers = sent.map((e) => JSON.parse(e.split("\n")[0]!) as { trace?: { transaction?: string } });
    expect(headers.some((h) => h.trace?.transaction === "GET /clients/[id]/sessions/[id]")).toBe(true);

    for (const envelope of sent) {
      const decoded = oracleDecode(envelope);
      expect(UUID_ANYWHERE.test(decoded), `a record id left in an envelope:\n${decoded.slice(0, 2000)}`).toBe(false);
    }
    expect(networkCalls).toEqual([]);
    await client.close();
  });

  it("NEGATIVE CONTROL: with the scrubbers unset, the same journey's envelopes carry the ids", async () => {
    const { client, sent } = makeClient(false);
    await driveJourney(client);
    const decoded = oracleDecode(sent.join("\n"));
    for (const id of [CLIENT, SESSION, STUDIO]) expect(decoded.toLowerCase()).toContain(id.toLowerCase());
    // ...including the envelope header's trace context.
    const headers = sent.map((e) => JSON.parse(e.split("\n")[0]!) as { trace?: { transaction?: string } });
    expect(headers.some((h) => h.trace?.transaction?.includes(CLIENT))).toBe(true);
    expect(networkCalls).toEqual([]);
    await client.close();
  });

  // A FETT treatment photo is shown through a Supabase Storage SIGNED URL: its
  // path names the studio, client and image, and its `token` is a JWT. The
  // browser's resource-timing span for that <img> carries the full URL.
  const SIGNED_IMAGE_URL =
    `https://abcdefghijklmnopqrst.supabase.example.invalid/storage/v1/object/sign/treatment-images/${STUDIO}/${CLIENT}/${SESSION}.webp` +
    "?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJ0cmVhdG1lbnQtaW1hZ2VzL3N5bnRoZXRpYyIsImlhdCI6MTcwMDAwMDAwMH0.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA";

  async function driveImageSpan(client: ServerRuntimeClient): Promise<void> {
    await startSpan(
      { name: "GET /clients/[id]/sessions/[id]", forceTransaction: true, op: "pageload", attributes: { "sentry.source": "route" } },
      async () => {
        await startSpan(
          { name: SIGNED_IMAGE_URL, op: "resource.img", attributes: { "http.url": SIGNED_IMAGE_URL, url: SIGNED_IMAGE_URL } },
          async () => undefined,
        );
      },
    );
    await client.flush(2000);
  }

  it("a Supabase signed treatment-image URL in a resource.img span: path ids become [id], the token [Redacted]", async () => {
    const { client, sent } = makeClient(true);
    await driveImageSpan(client);
    const tx = sent.find((e) => e.includes('"type":"transaction"'));
    expect(tx, "no transaction envelope was produced").toBeDefined();
    const decoded = oracleDecode(tx!);
    expect(decoded).toContain('"op":"resource.img"');
    expect(decoded).toContain("/storage/v1/object/sign/treatment-images/[id]/[id]/[id].webp?token=[Redacted]");
    expect(UUID_ANYWHERE.test(decoded), decoded.slice(0, 1500)).toBe(false);
    expect(decoded).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(networkCalls).toEqual([]);
    await client.close();
  });

  it("NEGATIVE CONTROL: unscrubbed, the same image span carries the path ids and the token", async () => {
    const { client, sent } = makeClient(false);
    await driveImageSpan(client);
    const decoded = oracleDecode(sent.join("\n"));
    for (const id of [STUDIO, CLIENT, SESSION]) expect(decoded.toLowerCase()).toContain(id.toLowerCase());
    expect(decoded).toMatch(/token=eyJ[A-Za-z0-9_-]{10,}/);
    expect(networkCalls).toEqual([]);
    await client.close();
  });

  it("the dummy DSN is not Hone's, and the network trap really traps (positive control)", () => {
    expect(DUMMY_DSN).toMatch(/\.invalid\//);
    const before = networkCalls.length;
    expect(() => fetch("https://o1.ingest.example.invalid/")).toThrow(/forbidden/);
    expect(() => https.request("https://o1.ingest.example.invalid/")).toThrow(/forbidden/);
    expect(networkCalls.length).toBe(before + 2);
    networkCalls.length = before;
  });
});
