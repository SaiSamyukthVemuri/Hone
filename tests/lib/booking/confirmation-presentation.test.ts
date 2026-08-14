import { describe, expect, it } from "vitest";
import {
  buildBookingConfirmationCopy,
  type ConfirmationEmailStatus,
} from "@/lib/booking/confirmation-presentation";

// ===========================================================================
// BOOK-01 Tranche 1, the public booking confirmation copy contract.
// ===========================================================================
//
// These are NOT source greps. The real copy builder runs, and the assertions
// are about what it actually returns for each provider outcome.
//
// The rule being protected has two halves, and both matter:
//
//   1. The management action is offered in EVERY state, because it is the
//      client's guaranteed path to the appointment and depends on no provider.
//   2. The narrative never asserts a delivery that did not happen, and never
//      points at the email as the client's ONLY route to management.
//
// Half 2 is what the pre-Tranche-1 card got wrong: it rendered "We sent a
// confirmation to <email>" and "The email includes links to cancel or
// reschedule" unconditionally, including when the provider had just failed and
// when the studio had confirmation emails switched off entirely.

const EMAIL = "booker@example.test";
const ALL: ConfirmationEmailStatus[] = ["sent", "failed", "disabled"];

describe("buildBookingConfirmationCopy: invariants across every status", () => {
  it("always offers a management action, whatever the provider did", () => {
    for (const emailStatus of ALL) {
      const copy = buildBookingConfirmationCopy({ emailStatus, email: EMAIL });
      expect(copy.manageLabel, `manageLabel missing for ${emailStatus}`).toBeTruthy();
      expect(copy.manageLabel).toBe("Manage booking");
    }
  });

  it("always produces at least one next-step line", () => {
    for (const emailStatus of ALL) {
      const copy = buildBookingConfirmationCopy({ emailStatus, email: EMAIL });
      expect(copy.steps.length, emailStatus).toBeGreaterThan(0);
      for (const step of copy.steps) {
        expect(step.trim(), `${emailStatus} produced a blank step`).not.toBe("");
      }
    }
  });

  it("claims delivery in EXACTLY ONE state, the one where the provider succeeded", () => {
    const claiming = ALL.filter(
      (emailStatus) =>
        buildBookingConfirmationCopy({ emailStatus, email: EMAIL }).claimsEmailDelivered,
    );
    expect(claiming).toEqual(["sent"]);
  });

  it("only points at the email for management in that same state", () => {
    const pointing = ALL.filter(
      (emailStatus) =>
        buildBookingConfirmationCopy({ emailStatus, email: EMAIL })
          .claimsEmailCarriesManagementLinks,
    );
    expect(pointing).toEqual(["sent"]);
  });

  it("never leaks a provider reason, status code or internal detail", () => {
    for (const emailStatus of ALL) {
      const joined = buildBookingConfirmationCopy({ emailStatus, email: EMAIL })
        .steps.join(" ")
        .toLowerCase();
      for (const forbidden of [
        "resend",
        "twilio",
        "smtp",
        "provider",
        "error",
        "exception",
        "retryable",
        "500",
        "429",
      ]) {
        expect(joined, `${emailStatus} copy leaks "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });
});

describe("buildBookingConfirmationCopy: sent", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "sent", email: EMAIL });

  it("names the address it actually delivered to", () => {
    expect(copy.steps.join(" ")).toContain(EMAIL);
  });

  it("may say the email carries the cancel/reschedule links", () => {
    expect(copy.claimsEmailDelivered).toBe(true);
    expect(copy.claimsEmailCarriesManagementLinks).toBe(true);
    expect(copy.steps.join(" ").toLowerCase()).toMatch(/cancel or reschedule/);
  });

  it("does not nag the client to save the link, they have a durable copy", () => {
    expect(copy.urgesSavingLink).toBe(false);
  });
});

describe("buildBookingConfirmationCopy: failed", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "failed", email: EMAIL });

  it("does NOT claim the confirmation was sent", () => {
    expect(copy.claimsEmailDelivered).toBe(false);
    const joined = copy.steps.join(" ");
    // The exact pre-Tranche-1 assertion must be absent. This is the specific
    // sentence that used to render unconditionally.
    expect(joined).not.toMatch(/^We sent a confirmation to/);
    expect(joined).not.toMatch(/We sent a confirmation to/);
  });

  it("does NOT tell the client their management links are in the email", () => {
    expect(copy.claimsEmailCarriesManagementLinks).toBe(false);
    expect(copy.steps.join(" ")).not.toMatch(
      /email includes links to cancel or reschedule/,
    );
  });

  it("points the client at the in-band link instead, and asks them to keep it", () => {
    expect(copy.urgesSavingLink).toBe(true);
    expect(copy.steps.join(" ")).toContain("Manage booking");
  });

  it("is honest that delivery is UNCONFIRMED rather than asserting failure to the client", () => {
    // "We couldn't confirm ... went through" is the truthful framing: the
    // provider refused our request, which is not the same as proving the
    // client will never see it.
    expect(copy.steps.join(" ").toLowerCase()).toMatch(/couldn’t confirm|couldn't confirm/);
  });
});

describe("buildBookingConfirmationCopy: disabled", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "disabled", email: EMAIL });

  it("does not mention a confirmation email at all, nothing was attempted", () => {
    expect(copy.claimsEmailDelivered).toBe(false);
    expect(copy.claimsEmailCarriesManagementLinks).toBe(false);
    const joined = copy.steps.join(" ").toLowerCase();
    expect(joined).not.toContain("confirmation email");
    expect(joined).not.toContain("we sent");
    // No apology either: the studio configured this deliberately.
    expect(joined).not.toMatch(/sorry|unfortunately|couldn’t|couldn't/);
  });

  it("does not name the client's address, since nothing was sent to it", () => {
    expect(copy.steps.join(" ")).not.toContain(EMAIL);
  });

  it("still routes the client to the in-band management link", () => {
    expect(copy.urgesSavingLink).toBe(true);
    expect(copy.steps.join(" ")).toContain("Manage booking");
  });
});
