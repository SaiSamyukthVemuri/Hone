import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import {
  completionPatchFromProfile,
  invitationEligibility,
  mobileIsVerified,
  mobileStanding,
  storedMobilePresent,
  validateWaitlistJoinProfile,
  PROFILE_COMPLETE,
  assessProfileCompleteness,
} from "@/lib/waitlist/join-profile";
import { prospectMayReceiveSms } from "@/lib/waitlist/prospect-sms-consent";
import { MOBILE_CANDIDATE_NOTE } from "@/lib/waitlist/join-copy";

// ===========================================================================
// #687 P2 — A BEARER LINK MAY NOT CHOOSE WHERE THE SMS GOES
// ===========================================================================
//
// The finding: the completion payload carried `mobile`, so whoever held a
// completion link could replace the number AND tick consent in the same
// submission — arriving as apparent agreement for a number of their choosing.
//
// The repair has two halves, and both are asserted here:
//   STRUCTURE  an entry that HOLDS a mobile produces a patch with no mobile
//              value in it at all. Replacement is unexpressible, not refused.
//   AUTHORITY  a number someone typed is a CANDIDATE. Only verification makes it
//              a destination, and consent never substitutes for it.
// ===========================================================================

/** Tags stripped and entities decoded, so copy is compared as a reader sees it. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const ON_FILE = {
  firstName: "Sarah",
  lastName: "Jones",
  email: "sarah@example.com",
  mobile: "07700 900123",
  treatmentAreaIds: ["chin"],
  availabilityPreference: "weekdays",
} as const;

/** The real legacy shape: one combined name, an email, and nothing else. */
const LEGACY = { legacyName: "Sarah Jones", email: "sarah@example.com" } as const;

function profile(mobile: string) {
  const v = validateWaitlistJoinProfile({
    firstName: "Sarah",
    lastName: "Jones",
    email: "sarah@example.com",
    mobile,
    treatmentAreaIds: ["chin"],
    availabilityPreference: "weekdays",
    smsOperationalConsent: true, // consent TICKED throughout — that is the threat
  });
  if (!v.ok) throw new Error("fixture invalid");
  return v.value;
}

describe("a stored mobile cannot be replaced by a completion payload", () => {
  it("the patch carries NO mobile value when one is on file", () => {
    const patch = completionPatchFromProfile(profile("07999 111222"), ON_FILE);
    expect(patch.mobileDisposition).toBe("unchanged");
    expect(patch).not.toHaveProperty("mobile");
    expect(patch).not.toHaveProperty("mobileCandidate");
  });

  it("even when the submission carried a DIFFERENT number", () => {
    // The attacker's number reaches validation and is simply not projected.
    const attacker = profile("07999 111222");
    expect(attacker.mobile).toBe("07999 111222");
    expect(JSON.stringify(completionPatchFromProfile(attacker, ON_FILE))).not.toContain(
      "07999",
    );
  });

  it("and the surface offers no control to type one into", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: ON_FILE,
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    // Not a disabled input — no mobile control at all when a number is on file.
    expect(html).not.toContain('type="tel"');
    expect(html).toContain('data-testid="waitlist-field-mobile-locked"');
  });
});

describe("a stored email remains immutable", () => {
  it("is absent from the patch and has no control", () => {
    const patch = completionPatchFromProfile(profile("07700 900123"), ON_FILE);
    expect(patch).not.toHaveProperty("email");
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: ON_FILE,
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).not.toContain('type="email"');
    expect(html).toContain('data-testid="waitlist-field-email-locked"');
  });
});

describe("a legacy entry with NO mobile may supply a candidate", () => {
  it("takes the candidate arm and carries the number", () => {
    const patch = completionPatchFromProfile(profile("07700 900123"), LEGACY);
    expect(patch.mobileDisposition).toBe("candidate_supplied");
    if (patch.mobileDisposition !== "candidate_supplied") return;
    expect(patch.mobileCandidate).toBe("07700 900123");
  });

  it("and the surface DOES offer the field", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: LEGACY,
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).toContain('data-testid="waitlist-field-mobile"');
    expect(html).not.toContain('data-testid="waitlist-field-mobile-locked"');
  });

  it("NON-VACUITY — the two arms are chosen by the ENTRY, not the submission", () => {
    const same = profile("07700 900123");
    expect(completionPatchFromProfile(same, LEGACY).mobileDisposition).toBe(
      "candidate_supplied",
    );
    expect(completionPatchFromProfile(same, ON_FILE).mobileDisposition).toBe("unchanged");
  });
});

describe("a candidate plus consent does NOT authorize SMS", () => {
  it("consent alone is not enough", () => {
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-09T10:00:00.000Z", // they DID agree
        sms_opted_out_at: null,
        mobile_verified_at: null, // ...to a number nobody has confirmed
      }),
    ).toBe(false);
  });

  it("a verified number without consent is not enough either", () => {
    expect(
      prospectMayReceiveSms({
        sms_consent_at: null,
        sms_opted_out_at: null,
        mobile_verified_at: "2026-09-09T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("NON-VACUITY — verified AND consented AND not opted out DOES send", () => {
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-09T10:00:00.000Z",
        sms_opted_out_at: null,
        mobile_verified_at: "2026-09-09T10:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("opt-out still dominates a verified, consented number", () => {
    expect(
      prospectMayReceiveSms({
        sms_consent_at: "2026-09-09T10:00:00.000Z",
        sms_opted_out_at: "2026-09-09T11:00:00.000Z",
        mobile_verified_at: "2026-09-09T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("a candidate is structurally and visibly unverified", () => {
  it("STRUCTURALLY — standing distinguishes it from a verified number", () => {
    expect(mobileStanding(LEGACY)).toBe("absent");
    expect(mobileStanding(ON_FILE)).toBe("candidate"); // held, never proven
    expect(mobileStanding({ ...ON_FILE, mobileVerifiedAt: "2026-09-09T10:00:00.000Z" })).toBe(
      "verified",
    );
    expect(mobileIsVerified(ON_FILE)).toBe(false);
    expect(storedMobilePresent(ON_FILE)).toBe(true); // present but NOT verified
  });

  it("VISIBLY — the surface says the number will be confirmed first", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: LEGACY,
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).toContain('data-testid="waitlist-mobile-candidate-note"');
    // Compare against DECODED text: React escapes the apostrophe to &#x27;, so a
    // raw-string containment check fails on correct markup.
    expect(visibleText(html)).toContain(MOBILE_CANDIDATE_NOTE);
  });

  it("WAIT-04A never invents a verification instant", () => {
    // No mechanism exists in this slice, so every stored profile reads unverified.
    expect(mobileIsVerified(ON_FILE)).toBe(false);
    expect(mobileIsVerified(LEGACY)).toBe(false);
  });
});

describe("eligibility fails closed until the mobile is verified", () => {
  it("an SMS-requiring invitation is refused on a candidate", () => {
    const verdict = invitationEligibility(ON_FILE, { requiresSms: true });
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) return;
    expect(verdict.reason).toBe("mobile_unverified");
    if (verdict.reason !== "mobile_unverified") return;
    expect(verdict.standing).toBe("candidate");
  });

  it("but the profile itself is COMPLETE, so they stay invitable by email", () => {
    // Completeness is not a claim about SMS. Blocking every invitation on an
    // unverified phone would strand a prospect who answered every question.
    expect(assessProfileCompleteness(ON_FILE).status).toBe(PROFILE_COMPLETE);
    expect(invitationEligibility(ON_FILE).eligible).toBe(true);
  });

  it("and a verified number clears the SMS bar", () => {
    expect(
      invitationEligibility(
        { ...ON_FILE, mobileVerifiedAt: "2026-09-09T10:00:00.000Z" },
        { requiresSms: true },
      ).eligible,
    ).toBe(true);
  });

  it("incompleteness is reported as incompleteness, never as a phone problem", () => {
    const verdict = invitationEligibility(LEGACY, { requiresSms: true });
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) return;
    expect(verdict.reason).toBe("profile_incomplete");
  });
});

describe("no new authority was added while closing this", () => {
  it("the patch still names no entry, no address, no join instant", () => {
    for (const stored of [ON_FILE, LEGACY]) {
      const patch = completionPatchFromProfile(profile("07700 900123"), stored);
      for (const forbidden of ["entryId", "entry_id", "email", "joinedAt", "joined_at"]) {
        expect(patch).not.toHaveProperty(forbidden);
      }
    }
  });

  it("the JOIN path's mobile requirement is unchanged", () => {
    // A new prospect still must give a mobile; only the COMPLETION path changed.
    const blank = validateWaitlistJoinProfile({
      firstName: "Sarah",
      lastName: "Jones",
      email: "sarah@example.com",
      mobile: "",
      treatmentAreaIds: ["chin"],
      availabilityPreference: "weekdays",
      smsOperationalConsent: false,
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.errors.mobile).toBeTruthy();
    // And a valid one still passes, carrying the number verbatim.
    expect(profile("07700 900123").mobile).toBe("07700 900123");
  });
});
