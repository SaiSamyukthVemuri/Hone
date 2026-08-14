import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/onboarding/state", () => ({
  claimWelcomeEmailAttempt: vi.fn(),
  recordWelcomeEmailResult: vi.fn(),
}));

import { deliverWelcomeEmail } from "@/lib/email/send-welcome";
import {
  claimWelcomeEmailAttempt,
  recordWelcomeEmailResult,
} from "@/lib/onboarding/state";

const claim = claimWelcomeEmailAttempt as unknown as Mock;
const record = recordWelcomeEmailResult as unknown as Mock;

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
  claim.mockResolvedValue({ attemptId: "att-1", error: false });
  record.mockResolvedValue({ applied: true, error: false });
});

afterEach(() => {
  delete process.env.HONE_E2E_FAKE_RESEND;
  delete process.env.HONE_E2E_FAKE_RESEND_MODE;
  vi.restoreAllMocks();
  claim.mockReset();
  record.mockReset();
});

describe("deliverWelcomeEmail: truthful send outcomes", () => {
  it("success -> 'sent', result stamped on THIS attempt, nothing logged", async () => {
    setFake("success");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("sent");
    expect(record).toHaveBeenCalledWith(admin, "studio-1", "att-1", "sent");
    expect(err).not.toHaveBeenCalled();
  });

  it("provider rejection -> 'failed', bounded marker, no recipient/provider text", async () => {
    setFake("reject");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("failed");
    expect(record).toHaveBeenCalledWith(admin, "studio-1", "att-1", "failed");
    expect(err).toHaveBeenCalledWith("welcome_email_error:send:provider_rejected");
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).not.toContain("alex@example.com");
    expect(logged).not.toContain("fake resend");
  });

  it("provider exception -> 'failed' + bounded marker", async () => {
    setFake("throw");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("failed");
    expect(err).toHaveBeenCalledWith("welcome_email_error:send:provider_exception");
  });
});

describe("deliverWelcomeEmail: claim / stamp error handling (no false success)", () => {
  it("claim RPC error -> 'failed', NOTHING sent, NOTHING recorded", async () => {
    setFake("success");
    claim.mockResolvedValueOnce({ attemptId: null, error: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("failed");
    expect(record).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("welcome_email_error:claim:write_failed");
  });

  it("lost the single-flight race -> 'already_in_progress', NOTHING sent", async () => {
    setFake("success");
    claim.mockResolvedValueOnce({ attemptId: null, error: false });
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("already_in_progress");
    expect(record).not.toHaveBeenCalled();
  });

  it("stamp write error after a successful send -> 'sent' + bounded stamp marker", async () => {
    setFake("success");
    record.mockResolvedValueOnce({ applied: false, error: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("sent");
    expect(err).toHaveBeenCalledWith("welcome_email_error:stamp:write_failed");
  });

  it("a newer attempt superseded the stamp (applied=false, no error) -> 'sent', no error marker", async () => {
    setFake("success");
    record.mockResolvedValueOnce({ applied: false, error: false });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverWelcomeEmail(admin, PARAMS)).toBe("sent");
    expect(err).not.toHaveBeenCalled();
  });
});
