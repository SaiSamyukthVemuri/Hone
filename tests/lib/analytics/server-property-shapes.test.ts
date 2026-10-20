import http from "node:http";
import https from "node:https";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// #828 G-26 row 18 (R18-1): server-side PostHog properties are checked by
// VALUE, not only by key. An allowed key carrying the wrong shape (a client id
// in `source`, a non-UUID `studio_id`, free text in `modality`) drops the
// WHOLE event, as a non-UUID distinctId already does. The event name must be
// one of the supported server event constants.
//
// WIRE-LEVEL: the REAL posthog-node client (built by lib/posthog-server.ts)
// sends through a capturing fetch; every body it would put on the wire is
// recorded and decoded. ZERO NETWORK: a dummy key, a .invalid host, and
// http(s).request trapped and asserted unused, with a positive control.
// All ids are SYNTHETIC.
// ===========================================================================

const STUDIO = "11111111-2222-4333-8444-555555555555";
const PRACTITIONER = "22222222-3333-4444-8555-666666666666";
const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";

const wire: Array<{ url: string; body: string }> = [];
const trapped: string[] = [];

async function bodyText(body: unknown): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  const buf =
    body instanceof Uint8Array
      ? Buffer.from(body)
      : body instanceof ArrayBuffer
        ? Buffer.from(body)
        : typeof (body as Blob).arrayBuffer === "function"
          ? Buffer.from(await (body as Blob).arrayBuffer())
          : Buffer.from(String(body));
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_dummyR18proofToken");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.example.invalid");
  vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
    wire.push({ url: String(input), body: await bodyText(init?.body) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.spyOn(http, "request").mockImplementation(((...a: unknown[]) => {
    trapped.push(`http ${JSON.stringify(a[0])}`);
    throw new Error("network egress is forbidden in this test");
  }) as typeof http.request);
  vi.spyOn(https, "request").mockImplementation(((...a: unknown[]) => {
    trapped.push(`https ${JSON.stringify(a[0])}`);
    throw new Error("network egress is forbidden in this test");
  }) as typeof https.request);
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(() => {
  wire.length = 0;
});

async function settle(): Promise<void> {
  // captureServerEvent schedules on a later macrotask and flushes with a
  // bounded race; give it time, then read what reached the wire.
  for (let i = 0; i < 40 && wire.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
}

async function capture(event: string, properties: Record<string, string | number | boolean | null | undefined>) {
  const { captureServerEvent } = await import("@/lib/analytics/server");
  captureServerEvent({ actor: { kind: "user", id: PRACTITIONER }, event, properties });
  await settle();
}

describe("R18-1: what posthog-node puts on the wire", () => {
  it("a well-shaped event is sent with exactly its allowed properties (positive control: the capture works)", async () => {
    await capture("appointment_booked", { studio_id: STUDIO, source: "practitioner_ui", modality: "electrolysis" });
    expect(wire.length).toBeGreaterThan(0);
    const all = wire.map((w) => w.body).join("\n");
    expect(all).toContain('"appointment_booked"');
    expect(all).toContain(STUDIO);
    expect(all).toContain('"practitioner_ui"');
    expect(wire.every((w) => w.url.startsWith("https://us.i.posthog.example.invalid/"))).toBe(true);
  });

  it.each([
    "appointment_booked", "card_on_file_saved", "client_created",
    "onboarding_wizard_completed", "onboarding_wizard_started",
    "payment_charge_executed", "payment_refunded", "public_appointment_booked",
    "session_started", "stripe_account_connected", "studio_created", "user_signed_in",
  ])("supported event %s still reaches the wire", async (event) => {
    await capture(event, { studio_id: STUDIO });
    expect(wire.map((entry) => entry.body).join("\n")).toContain(`"event":"${event}"`);
  });

  it.each([
    ["a client id in source", { studio_id: STUDIO, source: CLIENT }],
    ["free text in source", { studio_id: STUDIO, source: "Jane Synthetic booked" }],
    ["a non-UUID studio_id", { studio_id: "studio-name" }],
    ["an unknown modality", { studio_id: STUDIO, modality: `client ${CLIENT}` }],
    ["a string where a boolean belongs", { studio_id: STUDIO, is_new_session: "yes" as unknown as boolean }],
    ["an unknown provider", { provider: "password:hunter2" }],
  ])("%s: the WHOLE event is dropped, nothing reaches the wire", async (_label, props) => {
    await capture("appointment_booked", props);
    expect(wire).toEqual([]);
  });

  it("an event name carrying an id is dropped", async () => {
    await capture(`appointment_booked_${CLIENT}`, { studio_id: STUDIO });
    expect(wire).toEqual([]);
  });

  it.each([
    "client_created_abc123def456",
    "appointment_booked_15555550123",
    "unknown_event",
  ])("unsupported event %s is rejected without sending or logging its name", async (event) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await capture(event, { studio_id: STUDIO });
      expect(wire).toEqual([]);
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "analytics_event_name_rejected" }));
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(event);
    } finally {
      warn.mockRestore();
    }
  });

  it("an unknown KEY is still dropped by name (the event is sent without it)", async () => {
    await capture("client_created", { studio_id: STUDIO, client_id: CLIENT } as Record<string, string>);
    const all = wire.map((w) => w.body).join("\n");
    expect(all).toContain('"client_created"');
    expect(all.toLowerCase()).not.toContain(CLIENT);
  });

  it("no request left through http(s).request, and the trap really traps (positive control)", () => {
    expect(trapped).toEqual([]);
    expect(() => https.request("https://us.i.posthog.example.invalid/batch/")).toThrow(/forbidden/);
    expect(trapped).toHaveLength(1);
    trapped.length = 0;
  });
});
