import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_PREFERENCES,
  PROFILE_COMPLETE,
  PROFILE_INCOMPLETE,
  PROFILE_MOBILE_MIN_DIGITS,
  REQUIRED_PROFILE_FIELDS,
  assessProfileCompleteness,
  completionDraftFromStored,
  completionPatchFromProfile,
  displayName,
  emptyJoinProfileDraft,
  invitationEligibility,
  isAvailabilityPreference,
  validateWaitlistJoinProfile,
  waitTimeEstimatorInput,
  type RawJoinProfileInput,
} from "@/lib/waitlist/join-profile";

// A complete, valid submission. Every negative case below mutates ONE limb of
// this, so a failure names the limb rather than the fixture.
/** An entry that already HOLDS a mobile, so the patch takes the "unchanged" arm. */
const STORED_WITH_MOBILE = {
  firstName: "Sarah",
  lastName: "Jones",
  email: "sarah.jones@example.com",
  mobile: "07700 900123",
  treatmentAreaIds: ["chin"],
  availabilityPreference: "weekdays",
};

function goodInput(over: Partial<RawJoinProfileInput> = {}): RawJoinProfileInput {
  return {
    firstName: "Sarah",
    lastName: "Jones",
    email: "Sarah.Jones@Example.com",
    mobile: "07700 900123",
    treatmentAreaIds: ["chin", "upper_lip"],
    availabilityPreference: "weekdays",
    smsOperationalConsent: false,
    ...over,
  };
}

describe("the availability vocabulary is 0193's, restated", () => {
  // The DB authority is migration 0193 (WAIT-ADMIT-01), which is NOT in this
  // tree — this slice is based on production. The constraint text is embedded
  // here verbatim so a change to our union is caught against the wording it has
  // to satisfy, rather than against a comment.
  const CHECK_0193 =
    "check (preference in ('weekdays', 'weekends', 'both'))";

  it("matches the CHECK constraint exactly, in order", () => {
    const fromConstraint = [...CHECK_0193.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect([...AVAILABILITY_PREFERENCES]).toEqual(fromConstraint);
  });

  it("accepts only those three", () => {
    for (const value of AVAILABILITY_PREFERENCES) {
      expect(isAvailabilityPreference(value)).toBe(true);
    }
    for (const value of ["", "weekday", "Weekends", "any", "BOTH", null, 1, {}]) {
      expect(isAvailabilityPreference(value)).toBe(false);
    }
  });
});

describe("validation", () => {
  it("accepts a complete submission and normalises it", () => {
    const result = validateWaitlistJoinProfile(goodInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe("sarah.jones@example.com"); // lowercased
    expect(result.value.mobile).toBe("07700 900123"); // NOT coerced to E.164
    expect(result.value.treatmentAreaIds).toEqual(["upper_lip", "chin"]); // catalog order
  });

  it("requires first and last name SEPARATELY", () => {
    const noLast = validateWaitlistJoinProfile(goodInput({ lastName: "" }));
    expect(noLast.ok).toBe(false);
    if (noLast.ok) return;
    expect(noLast.errors.lastName).toBeTruthy();
    // A present first name does not cover for a missing last name.
    expect(noLast.errors.firstName).toBeUndefined();
  });

  it("reports EVERY failing field at once, not just the first", () => {
    const result = validateWaitlistJoinProfile({
      firstName: "",
      lastName: "",
      email: "nope",
      mobile: "",
      treatmentAreaIds: [],
      availabilityPreference: null,
      smsOperationalConsent: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [...REQUIRED_PROFILE_FIELDS].sort(),
    );
  });

  it("requires a mobile, and one with enough digits to be a number", () => {
    expect(validateWaitlistJoinProfile(goodInput({ mobile: "" })).ok).toBe(false);
    expect(validateWaitlistJoinProfile(goodInput({ mobile: "n/a" })).ok).toBe(false);
    expect(validateWaitlistJoinProfile(goodInput({ mobile: "12345" })).ok).toBe(false);
    // NON-VACUITY: exactly the minimum passes.
    const min = "0".repeat(PROFILE_MOBILE_MIN_DIGITS);
    expect(validateWaitlistJoinProfile(goodInput({ mobile: min })).ok).toBe(true);
  });

  it("requires at least one treatment area", () => {
    const result = validateWaitlistJoinProfile(goodInput({ treatmentAreaIds: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.treatmentAreaIds).toBe("Choose at least one area.");
  });

  it("NEGATIVE CONTROL — an arbitrary area string cannot enter the model", () => {
    for (const bad of [["Other"], ["elbow"], ["Chin"], ["chin", "elbow"], "chin"]) {
      const result = validateWaitlistJoinProfile(
        goodInput({ treatmentAreaIds: bad }),
      );
      expect(result.ok).toBe(false);
    }
    // NON-VACUITY: the same shape with catalog ids is accepted.
    expect(validateWaitlistJoinProfile(goodInput({ treatmentAreaIds: ["chin"] })).ok).toBe(
      true,
    );
  });

  it("requires a structured availability answer and has no free-text limb", () => {
    for (const bad of [null, "", "whenever", "Weekdays", "mornings"]) {
      expect(
        validateWaitlistJoinProfile(goodInput({ availabilityPreference: bad })).ok,
      ).toBe(false);
    }
  });

  it("treats SMS consent as opt-in and NEVER as required", () => {
    // Absent / falsey / a truthy non-`true` value are all "not consented"...
    for (const value of [undefined, null, false, "", "true", "on", 1]) {
      const result = validateWaitlistJoinProfile(
        goodInput({ smsOperationalConsent: value }),
      );
      expect(result.ok).toBe(true); // ...and NONE of them block the submission
      if (!result.ok) return;
      expect(result.value.smsOperationalConsent).toBe(false);
    }
    const consented = validateWaitlistJoinProfile(
      goodInput({ smsOperationalConsent: true }),
    );
    expect(consented.ok && consented.value.smsOperationalConsent).toBe(true);
  });

  it("consent is not a completeness field", () => {
    expect(REQUIRED_PROFILE_FIELDS).not.toContain("smsOperationalConsent");
  });
});

describe("legacy entries — do not fake completeness", () => {
  // The real shape: one combined name, an email, and nothing else.
  const legacy = { legacyName: "Sarah Jones", email: "sarah@example.com" };

  it("is PROFILE_INCOMPLETE, naming every genuinely missing field", () => {
    const assessed = assessProfileCompleteness(legacy);
    expect(assessed.status).toBe(PROFILE_INCOMPLETE);
    if (assessed.status !== PROFILE_INCOMPLETE) return;
    expect([...assessed.missing].sort()).toEqual(
      ["availabilityPreference", "firstName", "lastName", "mobile", "treatmentAreaIds"].sort(),
    );
    // The one field they DO have is not reported missing.
    expect(assessed.missing).not.toContain("email");
  });

  it("a combined name NEVER satisfies firstName or lastName", () => {
    const assessed = assessProfileCompleteness(legacy);
    if (assessed.status !== PROFILE_INCOMPLETE) throw new Error("expected incomplete");
    expect(assessed.missing).toContain("firstName");
    expect(assessed.missing).toContain("lastName");
  });

  it("the completion draft does not split the legacy name", () => {
    const draft = completionDraftFromStored(legacy);
    // "Sarah" / "Jones" would be a guess. Both start blank.
    expect(draft.firstName).toBe("");
    expect(draft.lastName).toBe("");
    expect(draft.email).toBe("sarah@example.com"); // the one real value carries
  });

  it("the completion draft never pre-ticks consent", () => {
    expect(completionDraftFromStored(legacy).smsOperationalConsent).toBe(false);
    expect(emptyJoinProfileDraft().smsOperationalConsent).toBe(false);
  });

  it("availability is never defaulted, on either draft", () => {
    expect(completionDraftFromStored(legacy).availabilityPreference).toBeNull();
    expect(emptyJoinProfileDraft().availabilityPreference).toBeNull();
  });

  it("a stored area outside the catalog makes the profile INCOMPLETE", () => {
    const assessed = assessProfileCompleteness({
      firstName: "Sarah",
      lastName: "Jones",
      email: "sarah@example.com",
      mobile: "07700900123",
      treatmentAreaIds: ["chin", "Other"],
      availabilityPreference: "both",
    });
    expect(assessed.status).toBe(PROFILE_INCOMPLETE);
    // And it is not pre-filled as though it were the person's own answer.
    expect(
      completionDraftFromStored({ treatmentAreaIds: ["chin", "Other"] }).treatmentAreaIds,
    ).toEqual([]);
  });

  it("NON-VACUITY — a fully populated row IS complete", () => {
    expect(
      assessProfileCompleteness({
        firstName: "Sarah",
        lastName: "Jones",
        email: "sarah@example.com",
        mobile: "07700900123",
        treatmentAreaIds: ["chin"],
        availabilityPreference: "both",
      }).status,
    ).toBe(PROFILE_COMPLETE);
  });

  it("displays the combined legacy name as given", () => {
    expect(displayName(legacy)).toBe("Sarah Jones");
    expect(displayName({ firstName: "Sarah", lastName: "Jones" })).toBe("Sarah Jones");
    // A mononym stays a mononym.
    expect(displayName({ legacyName: "Prince" })).toBe("Prince");
  });
});

describe("invite-to-book eligibility", () => {
  it("blocks an incomplete profile and names what is missing", () => {
    const verdict = invitationEligibility({ legacyName: "Sarah Jones", email: "s@e.com" });
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) return;
    expect(verdict.reason).toBe("profile_incomplete");
    if (verdict.reason !== "profile_incomplete") return;
    expect(verdict.missing).toContain("treatmentAreaIds");
  });

  it("allows a complete profile", () => {
    expect(
      invitationEligibility({
        firstName: "Sarah",
        lastName: "Jones",
        email: "s@e.com",
        mobile: "07700900123",
        treatmentAreaIds: ["chin"],
        availabilityPreference: "weekends",
      }).eligible,
    ).toBe(true);
  });
});

describe("completing a profile cannot move the queue position", () => {
  it("the patch type has NO joinedAt limb", () => {
    const validated = validateWaitlistJoinProfile(goodInput());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const patch = completionPatchFromProfile(validated.value, STORED_WITH_MOBILE);
    // Structural, not intentional: there is no key to write through.
    expect(Object.keys(patch).sort()).toEqual(
      [
        "availabilityPreference",
        "firstName",
        "lastName",
        "mobileDisposition",
        "treatmentAreaIds",
      ].sort(),
    );
    expect(patch).not.toHaveProperty("joinedAt");
    expect(patch).not.toHaveProperty("joined_at");
  });

  it("the patch carries NO email, so a leaked link cannot redirect the invitation", () => {
    const validated = validateWaitlistJoinProfile(goodInput());
    if (!validated.ok) throw new Error("fixture invalid");
    const patch = completionPatchFromProfile(validated.value, STORED_WITH_MOBILE);
    // The surface renders the address as text with no control, but the TYPE is
    // what stops a forged post presenting one. The server resolves the address
    // from the entry it already authorised.
    expect(patch).not.toHaveProperty("email");
    // NON-VACUITY: the profile it was projected from DOES carry the address, so
    // this is an omission the projection performs, not a field that never existed.
    expect(validated.value.email).toBe("sarah.jones@example.com");
  });

  it("the three WHO/WHERE fields are all absent together", () => {
    const validated = validateWaitlistJoinProfile(goodInput());
    if (!validated.ok) throw new Error("fixture invalid");
    const patch = completionPatchFromProfile(validated.value, STORED_WITH_MOBILE);
    for (const forbidden of ["entryId", "entry_id", "email", "joinedAt", "joined_at"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
    // And every field a prospect MAY legitimately change is still there.
    for (const allowed of [
      "firstName",
      "lastName",
      "treatmentAreaIds",
      "availabilityPreference",
    ]) {
      expect(patch).toHaveProperty(allowed);
    }
  });

  it("the patch carries no entry id for a caller to name a row with", () => {
    const validated = validateWaitlistJoinProfile(goodInput());
    if (!validated.ok) throw new Error("fixture invalid");
    const patch = completionPatchFromProfile(validated.value, STORED_WITH_MOBILE);
    expect(patch).not.toHaveProperty("entryId");
    expect(patch).not.toHaveProperty("entry_id");
  });

  it("consent does not travel inside the patch", () => {
    const validated = validateWaitlistJoinProfile(
      goodInput({ smsOperationalConsent: true }),
    );
    if (!validated.ok) throw new Error("fixture invalid");
    expect(completionPatchFromProfile(validated.value, STORED_WITH_MOBILE)).not.toHaveProperty(
      "smsOperationalConsent",
    );
  });
});

describe("the wait-time estimator's typed input", () => {
  const context = { joinedAt: "2026-09-01T10:00:00.000Z", aheadInQueue: 4 };

  it("is emitted for a complete profile", () => {
    expect(
      waitTimeEstimatorInput(
        {
          firstName: "Sarah",
          lastName: "Jones",
          email: "s@e.com",
          mobile: "07700900123",
          treatmentAreaIds: ["chin"],
          availabilityPreference: "weekdays",
        },
        context,
      ),
    ).toEqual({
      joinedAt: context.joinedAt,
      availabilityPreference: "weekdays",
      treatmentAreaIds: ["chin"],
      aheadInQueue: 4,
    });
  });

  it("REFUSES rather than guessing when availability is unknown", () => {
    expect(
      waitTimeEstimatorInput({ treatmentAreaIds: ["chin"] }, context),
    ).toBeNull();
    expect(
      waitTimeEstimatorInput({ availabilityPreference: "both" }, context),
    ).toBeNull();
  });

  it("carries a null queue count rather than defaulting it to 0", () => {
    const input = waitTimeEstimatorInput(
      { treatmentAreaIds: ["chin"], availabilityPreference: "both" },
      { joinedAt: context.joinedAt, aheadInQueue: null },
    );
    // `0` would read as "you're next" to anything that rendered it.
    expect(input?.aheadInQueue).toBeNull();
  });
});
