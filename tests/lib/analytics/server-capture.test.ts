import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral tests for the safe server-side analytics dispatch
// (P1/P2-ANALYTICS-03 + Correction 2 + scenarios 15-16): product success never
// depends on analytics; dispatch is post-response + bounded; properties are
// allowlisted; distinctIds are UUID-validated fail-closed; identify carries an
// opaque id + validated role only.

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

const UID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

async function runScheduled(): Promise<void> {
  for (const call of afterMock.mock.calls) await call[0]();
  afterMock.mockClear();
}

beforeEach(() => {
  vi.resetAllMocks();
  flushMock.mockResolvedValue(undefined);
});

describe("captureServerEvent: dispatch discipline (scenario 15)", () => {
  it("schedules via after() and does not touch PostHog inline", () => {
    captureServerEvent({
      actor: { kind: "user", id: UID },
      event: "client_created",
      properties: { studio_id: SID },
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("sends the resolved distinctId for a user and a studio actor", async () => {
    captureServerEvent({ actor: { kind: "user", id: UID }, event: "a" });
    captureServerEvent({ actor: { kind: "studio", id: SID }, event: "b" });
    await runScheduled();
    expect(captureMock.mock.calls[0][0].distinctId).toBe(UID);
    expect(captureMock.mock.calls[1][0].distinctId).toBe(`studio:${SID}`);
  });

  it("allowlists properties and drops unknown keys entirely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureServerEvent({
      actor: { kind: "user", id: UID },
      event: "session_started",
      properties: {
        studio_id: SID,
        modality: "electrolysis",
        client_name: "Synthia Testcase",
        treatment_note: "synthetic",
      },
    });
    await runScheduled();
    const sent = captureMock.mock.calls[0][0];
    expect(sent.properties).toEqual({ studio_id: SID, modality: "electrolysis" });
    expect(JSON.stringify(sent)).not.toContain("Synthia");
    expect(JSON.stringify(sent)).not.toContain("synthetic");
    warn.mockRestore();
  });
});

describe("captureServerEvent: opaque-id enforcement (Correction 2)", () => {
  it("drops the event when the actor id is not a UUID, without logging the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureServerEvent({
      actor: { kind: "user", id: "jane.doe@example.com" },
      event: "client_created",
    });
    await runScheduled();
    expect(captureMock).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("analytics_actor_rejected");
    expect(logged).not.toContain("jane.doe@example.com");
    warn.mockRestore();
  });
});

describe("captureServerEvent: never affects product (scenario 16)", () => {
  it("does not throw when capture or flush fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    captureMock.mockImplementation(() => {
      throw new Error("capture boom");
    });
    expect(() =>
      captureServerEvent({ actor: { kind: "user", id: UID }, event: "e" }),
    ).not.toThrow();
    await expect(runScheduled()).resolves.toBeUndefined();

    captureMock.mockReset();
    flushMock.mockRejectedValue(new Error("network down"));
    captureServerEvent({ actor: { kind: "user", id: UID }, event: "e" });
    await expect(runScheduled()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("bounds a hung flush with the timeout race", async () => {
    vi.useFakeTimers();
    try {
      flushMock.mockReturnValue(new Promise(() => {}));
      captureServerEvent({ actor: { kind: "user", id: UID }, event: "payment_charge_executed" });
      const scheduled = afterMock.mock.calls[0][0]() as Promise<void>;
      let settled = false;
      void scheduled.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to caught fire-and-forget when after() is unavailable", async () => {
    afterMock.mockImplementation(() => {
      throw new Error("after() outside request scope");
    });
    expect(() =>
      captureServerEvent({ actor: { kind: "studio", id: SID }, event: "card_on_file_saved" }),
    ).not.toThrow();
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
  });
});

describe("identifyServerUser", () => {
  it("identifies by opaque UUID with a validated role", async () => {
    identifyServerUser({ id: UID, role: "owner" });
    await runScheduled();
    expect(identifyMock.mock.calls[0][0]).toEqual({
      distinctId: UID,
      properties: { role: "owner" },
    });
  });

  it("drops an unknown role but still identifies by id", async () => {
    identifyServerUser({ id: UID, role: "super_admin" });
    await runScheduled();
    expect(identifyMock.mock.calls[0][0]).toEqual({ distinctId: UID });
  });

  it("drops the identify entirely when the id is not a UUID (no value logged)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    identifyServerUser({ id: "jane@example.com", role: "owner" });
    await runScheduled();
    expect(identifyMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
      "jane@example.com",
    );
    warn.mockRestore();
  });

  it("never throws when identify fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    identifyMock.mockImplementation(() => {
      throw new Error("identify boom");
    });
    expect(() => identifyServerUser({ id: UID })).not.toThrow();
    await expect(runScheduled()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
