import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BILLING_LOCK_STAFF_MESSAGE, isBillingLockError } from "@/lib/subscriptions/lock-message";

vi.mock("server-only", () => ({}));

describe("billing lock text", () => {
  it("gives staff neutral wording and never the internal code", async () => {
    const { mapSessionCommandError } = await import("@/lib/sessions/session-command-errors");
    for (const message of ["subscription_payment_required", "subscription_canceled", "ERROR: subscription_payment_required (P0001)"]) {
      const text = mapSessionCommandError({ message, code: "P0001" }, () => {});
      expect(text).toBe(BILLING_LOCK_STAFF_MESSAGE);
      expect(text).not.toMatch(/subscription|payment|billing|cancel/i);
    }
    expect(isBillingLockError({ message: "subscription_canceled" })).toBe(true);
    expect(isBillingLockError({ message: "something else" })).toBe(false);
    expect(isBillingLockError(null)).toBe(false);
  });

  it("shows staff the same neutral wording at the desk", () => {
    const source = readFileSync("app/(desk)/desk/booking-actions.ts", "utf8");
    expect(source).toContain("isBillingLockError(booked.error)");
    expect(source).toContain("BILLING_LOCK_STAFF_MESSAGE");
  });

  it("keeps the public booking and portal paths from ever reading or revealing the lock", () => {
    for (const file of ["app/book/[slug]/actions.ts", "app/portal/rebook-actions.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/subscription_(payment_required|canceled)|lock-message|BILLING_LOCK/);
      expect(source, file).not.toMatch(/(rpcErr|booked\.error|error)\??\.message\s*[,)}]/);
    }
  });
});
