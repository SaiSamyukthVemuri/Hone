import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral tests for the safe server-side analytics dispatch
// (P1/P2-ANALYTICS-03): product success never depends on analytics success,
// dispatch is post-response and bounded, and event properties are allowlisted.

const afterMock = vi.fn();
const captureMock = vi.fn();
const identifyMock = vi.fn();
const flushMock = vi.fn();

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => afterMock(work),
}));

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({
    capture: captureMock,
    identify: identifyMock,
    flush: flushMock,
  }),
}));

import { captureServerEvent, identifyServerUser } from "@/lib/analytics/server";

// Run whatever work was scheduled via after().
async function runScheduled(): Promise<void> {
  for (const call of afterMock.mock.calls) {
    await call[0]();
  }
  afterMock.mockClear();
}

beforeEach(() => {
  // resetAllMocks clears implementations too (a leaked mockImplementation
  // from one test must not bleed into the next).
  vi.resetAllMocks();
  flushMock.mockResolvedValue(undefined);
});

describe("captureServerEvent", () => {
  it("schedules via after() and does not touch PostHog inline", () => {
    captureServerEvent({
      distinctId: "prac-1",
      event: "client_created",
      properties: { studio_id: "studio-1" },
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(captureMock).not.toHaveBeenCalled(); // nothing happens pre-response
  });

  it("sends allowlisted properties and drops unknown keys entirely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureServerEvent({
      distinctId: "prac-1",
      event: "session_started",
      properties: {
        studio_id: "studio-1",
        modality: "electrolysis",
        is_new_session: true,
        client_name: "Synthia Testcase", // must never leave the process
        treatment_note: "synthetic", // must never leave the process
      },
    });
    await runScheduled();
    expect(captureMock).toHaveBeenCalledTimes(1);
    const sent = captureMock.mock.calls[0][0];
    expect(sent.properties).toEqual({
      studio_id: "studio-1",
      modality: "electrolysis",
      is_new_session: true,
    });
    expect(JSON.stringify(sent)).not.toContain("Synthia");
    expect(JSON.stringify(sent)).not.toContain("synthetic");
    // Dropped keys emit a name-only signal (no values).
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("analytics_property_dropped");
    expect(logged).toContain("client_name");
    expect(logged).not.toContain("Synthia");
    warn.mockRestore();
  });

  it("never throws when capture or flush fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureMock.mockImplementation(() => {
      throw new Error("capture boom");
    });
    expect(() =>
      captureServerEvent({ distinctId: "p", event: "appointment_booked" }),
    ).not.toThrow();
    await expect(runScheduled()).resolves.toBeUndefined();

    captureMock.mockReset();
    flushMock.mockRejectedValue(new Error("network down"));
    captureServerEvent({ distinctId: "p", event: "appointment_booked" });
    await expect(runScheduled()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("bounds a hanging flush with the timeout race", async () => {
    vi.useFakeTimers();
    try {
      flushMock.mockReturnValue(new Promise(() => {})); // hangs forever
      captureServerEvent({ distinctId: "p", event: "payment_charge_executed" });
      const scheduled = afterMock.mock.calls[0][0]() as Promise<void>;
      let settled = false;
      void scheduled.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2100); // past DISPATCH_TIMEOUT_MS
      expect(settled).toBe(true); // resolved despite the hung flush
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to fire-and-forget when after() is unavailable", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("after() outside request scope");
    });
    expect(() =>
      captureServerEvent({
        distinctId: "p",
        event: "card_on_file_saved",
        properties: { studio_id: "s", livemode: false },
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
  });
});

describe("identifyServerUser", () => {
  it("identifies by opaque id only — no person properties are sent", async () => {
    identifyServerUser({ distinctId: "auth-user-1" });
    await runScheduled();
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock.mock.calls[0][0]).toEqual({
      distinctId: "auth-user-1",
    });
    // The wrapper's type does not accept properties; assert the wire call
    // carries none (no email/name can ride an identify).
    expect(
      Object.keys(identifyMock.mock.calls[0][0]),
    ).toEqual(["distinctId"]);
  });

  it("never throws when identify fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    identifyMock.mockImplementation(() => {
      throw new Error("identify boom");
    });
    expect(() => identifyServerUser({ distinctId: "u" })).not.toThrow();
    await expect(runScheduled()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
