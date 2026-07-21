import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Mock the DB-backed claim + stamp so we can unit-test the send path (fake
// transport) without a database.
vi.mock("@/lib/onboarding/state", () => ({
  claimWelcomeEmailAttempt: vi.fn(),
  stampWelcomeEmailStatus: vi.fn(),
}));

import { deliverWelcomeEmail } from "@/lib/email/send-welcome";
import {
  claimWelcomeEmailAttempt,
  stampWelcomeEmailStatus,
} from "@/lib/onboarding/state";

const claim = claimWelcomeEmailAttempt as unknown as Mock;
const stamp = stampWelcomeEmailStatus as unknown as Mock;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin = {} as any;
const PARAMS = {
  studioId: "studio-1",
  ownerDisplayName: "Alex",
  ownerEmail: "alex@example.com",
  studioName: "Rivera Electrolysis",
  bookingUrl: "",
};

function setFake(mode: "success" | "reject" | "throw"): void {
  process.env.HONE_E2E_FAKE_RESEND = "1";
  process.env.HONE_E2E_FAKE_RESEND_MODE = mode;
}

beforeEach(() => {
  claim.mockResolvedValue(true);
  stamp.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.HONE_E2E_FAKE_RESEND;
  delete process.env.HONE_E2E_FAKE_RESEND_MODE;
  vi.restoreAllMocks();
  claim.mockReset();
  stamp.mockReset();
});

describe("deliverWelcomeEmail — send outcomes", () => {
  it("success -> 'sent', status stamped, nothing logged as an error", async () => {
    setFake("success");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("sent");
    expect(stamp).toHaveBeenCalledWith(admin, "studio-1", "sent");
    expect(err).not.toHaveBeenCalled();
  });

  it("provider rejection -> 'failed' + bounded marker, no recipient/provider text", async () => {
    setFake("reject");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("failed");
    expect(stamp).toHaveBeenCalledWith(admin, "studio-1", "failed");
    expect(err).toHaveBeenCalledWith(
      "welcome_email_error:send:provider_rejected",
    );
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).not.toContain("alex@example.com"); // no recipient
    expect(logged).not.toContain("fake resend"); // no raw provider message
  });

  it("provider exception -> 'failed' + bounded marker", async () => {
    setFake("throw");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("failed");
    expect(err).toHaveBeenCalledWith(
      "welcome_email_error:send:provider_exception",
    );
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).not.toContain("alex@example.com");
  });

  it("no fake + no key -> 'not_sent' (nothing sent, recorded honestly)", async () => {
    // Neither the fake nor a real key -> transport is null.
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("not_sent");
    expect(stamp).toHaveBeenCalledWith(admin, "studio-1", "not_sent");
  });
});

describe("deliverWelcomeEmail — single-attempt idempotency", () => {
  it("not claimed (concurrent double-click) -> does not send or stamp again", async () => {
    setFake("success");
    claim.mockResolvedValueOnce(false);
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("sent"); // the other in-flight attempt owns the send
    expect(stamp).not.toHaveBeenCalled();
  });

  it("claim write error -> fail-open (still sends once), bounded marker", async () => {
    setFake("success");
    claim.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await deliverWelcomeEmail(admin, PARAMS);
    expect(status).toBe("sent");
    expect(err).toHaveBeenCalledWith("welcome_email_error:claim:write_failed");
  });
});
