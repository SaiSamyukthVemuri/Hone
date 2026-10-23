import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuePortalMagicLink } from "@/lib/portal/magic-link";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/email/send-appointment", () => ({ sendEmailSafely: mocks.send }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.example.test" }));
vi.mock("@/lib/portal/tokens", () => ({
  generateRawToken: () => "synthetic-raw-secret",
  hashToken: () => "synthetic-token-hash",
}));

const STUDIO = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const CLIENT = "7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const input = { studioId: STUDIO, clientId: CLIENT, email: "patient@example.test", studioName: "Synthetic studio" };

beforeEach(() => { mocks.send.mockReset(); mocks.send.mockResolvedValue({ ok: true }); });
afterEach(() => { vi.restoreAllMocks(); });

function captureLogs() {
  // Both console levels are captured so the prior console.log path cannot
  // escape the oracle when the implementation uses safeLog.info.
  return [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
}

function payload(logs: ReturnType<typeof captureLogs>) {
  const calls = logs.flatMap((log) => log.mock.calls);
  expect(calls).toHaveLength(1);
  return JSON.parse(String(calls[0]![0])) as Record<string, unknown>;
}

function noIds(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text).not.toContain(input.email);
  expect(text).not.toContain("synthetic-raw-secret");
  expect(text).not.toContain("synthetic-token-hash");
}

describe("portal magic-link operational logs withhold record ids", () => {
  it("redacts studio/client ids on success while preserving issuance", async () => {
    const logs = captureLogs();
    const insert = vi.fn(async () => ({ error: null }));
    expect(await issuePortalMagicLink({ from: () => ({ insert }) }, input)).toEqual({ ok: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ studio_id: STUDIO, client_id: CLIENT, token_hash: "synthetic-token-hash" }));
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: input.email }));
    const event = payload(logs);
    expect(event).toMatchObject({ event: "portal_magic_link_sent", studioId: "[id]", clientId: "[id]" });
    noIds(event);
  });

  it("omits raw and encoded ids in a database failure, without sending", async () => {
    const logs = captureLogs();
    const error = { code: "23503", message: `client=${CLIENT},studio=${STUDIO.replace(/-/g, "%2D")}` };
    expect(await issuePortalMagicLink({ from: () => ({ insert: async () => ({ error }) }) }, input)).toMatchObject({ ok: false });
    expect(mocks.send).not.toHaveBeenCalled();
    const event = payload(logs);
    expect(event).toEqual({ event: "portal_magic_link_insert_failed", code: "23503", timestamp: expect.any(String) });
    noIds(event);
  });

  it("withholds database error free text while preserving the failure code and return", async () => {
    const logs = captureLogs();
    const sentinel = `${input.email} clinical-private-sentinel synthetic-raw-secret synthetic-token-hash`;
    const error = { code: "23514", message: `Rejected row: ${sentinel}` };
    expect(await issuePortalMagicLink({ from: () => ({ insert: async () => ({ error }) }) }, input))
      .toEqual({ ok: false, error: "Could not create the portal link. Please try again." });
    expect(mocks.send).not.toHaveBeenCalled();
    const event = payload(logs);
    expect(event).toEqual({ event: "portal_magic_link_insert_failed", code: "23514", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(String(event.timestamp)))).toBe(false);
    noIds(event);
    expect(JSON.stringify(event)).not.toContain("clinical-private-sentinel");
  });

  it("preserves the send-refusal marker and retryability without identifiers", async () => {
    const logs = captureLogs();
    mocks.send.mockResolvedValue({ ok: false, retryable: true });
    expect(await issuePortalMagicLink({ from: () => ({ insert: async () => ({ error: null }) }) }, input)).toMatchObject({ ok: false });
    const event = payload(logs);
    expect(event).toMatchObject({ event: "portal_magic_link_email_failed", retryable: true });
    noIds(event);
  });
});
