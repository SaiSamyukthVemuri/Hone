import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingConfirmationCopy,
  type ConfirmationEmailStatus,
} from "@/lib/booking/confirmation-presentation";

// ===========================================================================
// BOOK-01 Tranche 1 — the public booking confirmation copy contract.
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
// reschedule" unconditionally — including when the provider had just failed and
// when the studio had confirmation emails switched off entirely.

const EMAIL = "booker@example.test";
const ALL: ConfirmationEmailStatus[] = ["sent", "failed", "disabled"];

const ALL_ON = { cancellation: true, reschedule: true, manageLink: true } as const;

describe("buildBookingConfirmationCopy — invariants across every status", () => {
  it("always offers a management action, whatever the provider did", () => {
    for (const emailStatus of ALL) {
      const copy = buildBookingConfirmationCopy({ emailStatus, email: EMAIL, selfService: ALL_ON });
      expect(copy.manageLabel, `manageLabel missing for ${emailStatus}`).toBeTruthy();
      expect(copy.manageLabel).toBe("Manage booking");
    }
  });

  it("always produces at least one next-step line", () => {
    for (const emailStatus of ALL) {
      const copy = buildBookingConfirmationCopy({ emailStatus, email: EMAIL, selfService: ALL_ON });
      expect(copy.steps.length, emailStatus).toBeGreaterThan(0);
      for (const step of copy.steps) {
        expect(step.trim(), `${emailStatus} produced a blank step`).not.toBe("");
      }
    }
  });

  it("claims delivery in EXACTLY ONE state — the one where the provider succeeded", () => {
    const claiming = ALL.filter(
      (emailStatus) =>
        buildBookingConfirmationCopy({ emailStatus, email: EMAIL, selfService: ALL_ON }).claimsEmailDelivered,
    );
    expect(claiming).toEqual(["sent"]);
  });

  it("only points at the email for management in that same state", () => {
    const pointing = ALL.filter(
      (emailStatus) =>
        buildBookingConfirmationCopy({ emailStatus, email: EMAIL, selfService: ALL_ON })
          .claimsEmailCarriesManagementLinks,
    );
    expect(pointing).toEqual(["sent"]);
  });

  it("never leaks a provider reason, status code or internal detail", () => {
    for (const emailStatus of ALL) {
      const joined = buildBookingConfirmationCopy({ emailStatus, email: EMAIL, selfService: ALL_ON })
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

describe("buildBookingConfirmationCopy — sent", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "sent", email: EMAIL, selfService: ALL_ON });

  it("names the address it actually delivered to", () => {
    expect(copy.steps.join(" ")).toContain(EMAIL);
  });

  it("may say the email carries the cancel/reschedule links", () => {
    expect(copy.claimsEmailDelivered).toBe(true);
    expect(copy.claimsEmailCarriesManagementLinks).toBe(true);
    expect(copy.steps.join(" ").toLowerCase()).toMatch(/cancel or reschedule/);
  });

  it("does not nag the client to save the link — they have a durable copy", () => {
    expect(copy.urgesSavingLink).toBe(false);
  });
});

describe("buildBookingConfirmationCopy — failed", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "failed", email: EMAIL, selfService: ALL_ON });

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

describe("buildBookingConfirmationCopy — disabled", () => {
  const copy = buildBookingConfirmationCopy({ emailStatus: "disabled", email: EMAIL, selfService: ALL_ON });

  it("does not mention a confirmation email at all — nothing was attempted", () => {
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


// Codex P2 4370339942. The copy follows what the studio offers online: no line
// promises a link in the email, or a "Manage booking" button, that is not there.
describe("buildBookingConfirmationCopy — studio self-service (HON-47)", () => {
  const STATUSES = ["sent", "failed", "disabled"] as const;
  const BOOL = [true, false] as const;
  const EMAIL = "client@example.test";
  const text = (steps: string[]) => steps.join("\n");

  it("everything on is the studio-agnostic copy it always was", () => {
    expect(text(buildBookingConfirmationCopy({ emailStatus: "sent", email: EMAIL, selfService: ALL_ON }).steps)).toContain(
      "The email includes links to cancel or reschedule if your plans change.",
    );
  });

  it("selfService is REQUIRED: no optional parameter, no permissive default, and every caller passes it", () => {
    const lib = readFileSync(join(process.cwd(), "lib/booking/confirmation-presentation.ts"), "utf8");
    expect(lib).toMatch(/\n  selfService: ConfirmationSelfService;\n\}\): BookingConfirmationCopy/);
    expect(lib).not.toMatch(/ALL_SELF_SERVICE|selfService\?:|selfService \?\?/);
    // Every call site in the product, found by scanning, passes the capabilities.
    const callers = ["app/book/[slug]/PublicBookForm.tsx", "app/portal/PortalRebookCard.tsx"];
    for (const file of callers) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const calls = [...src.matchAll(/buildBookingConfirmationCopy\(\{([\s\S]*?)\n\s*\}\);/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const c of calls) expect(c[1], file).toContain("selfService");
    }
    // And no other product file calls it unscanned.
    const found = execFileSync("grep", ["-rl", "buildBookingConfirmationCopy(", "app", "lib", "components"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "lib/booking/confirmation-presentation.ts").sort();
    expect(found).toEqual(callers.map((c) => c).sort());
  });

  it.each(STATUSES)("%s: cancel x reschedule x manage link — the text names only what is offered", (emailStatus) => {
    for (const cancellation of BOOL) {
      for (const reschedule of BOOL) {
        for (const manageLink of BOOL) {
          const label = `${emailStatus} c=${cancellation} r=${reschedule} m=${manageLink}`;
          const copy = buildBookingConfirmationCopy({
            emailStatus,
            email: EMAIL,
            selfService: { cancellation, reschedule, manageLink },
          });
          const t = text(copy.steps);
          // The two actions are named only when offered.
          expect(/cancel/i.test(t), `${label} cancel`).toBe(cancellation && (emailStatus === "sent" || manageLink));
          expect(/reschedule/i.test(t), `${label} reschedule`).toBe(reschedule && (emailStatus === "sent" || manageLink));
          // The button is promised only in the states that point at it, and only when it is rendered.
          expect(t.includes("Manage booking below"), `${label} button`).toBe(emailStatus !== "sent" && manageLink);
          // Nothing asks the client to save a link that is not shown.
          expect(copy.urgesSavingLink, `${label} save`).toBe(emailStatus !== "sent" && manageLink);
          expect(copy.claimsEmailCarriesManagementLinks, `${label} claim`).toBe(
            emailStatus === "sent" && (cancellation || reschedule),
          );
          // A steps list is never empty and never carries a blank line.
          expect(copy.steps.length).toBeGreaterThan(0);
          expect(copy.steps.every((l) => l.trim().length > 0)).toBe(true);
        }
      }
    }
  });

  it("only one action on: the email line is singular and names that action", () => {
    const c = buildBookingConfirmationCopy({
      emailStatus: "sent", email: EMAIL, selfService: { cancellation: true, reschedule: false, manageLink: true },
    });
    expect(c.steps).toContain("The email includes a link to cancel if your plans change.");
    const r = buildBookingConfirmationCopy({
      emailStatus: "sent", email: EMAIL, selfService: { cancellation: false, reschedule: true, manageLink: true },
    });
    expect(r.steps).toContain("The email includes a link to reschedule if your plans change.");
  });

  it("everything off: the copy says nothing about links, buttons or saving", () => {
    for (const emailStatus of STATUSES) {
      const c = buildBookingConfirmationCopy({
        emailStatus, email: EMAIL, selfService: { cancellation: false, reschedule: false, manageLink: false },
      });
      const t = text(c.steps);
      expect(/Manage booking|bookmark|cancel|reschedule/i.test(t)).toBe(false);
      expect(c.urgesSavingLink).toBe(false);
    }
  });

  it("the form passes the studio's flags and whether the button renders", () => {
    const src = readFileSync(join(process.cwd(), "app/book/[slug]/PublicBookForm.tsx"), "utf8");
    expect(src).toMatch(/selfService: \{\s*\.\.\.confirmation\.selfService,\s*manageLink: confirmation\.manageUrl !== null,\s*\}/);
    const actions = readFileSync(join(process.cwd(), "app/book/[slug]/actions.ts"), "utf8");
    expect(actions).toMatch(/selfService: \{\s*cancellation: clientSelfService\.cancellation,\s*reschedule: clientSelfService\.reschedule,\s*\}/);
  });
});
