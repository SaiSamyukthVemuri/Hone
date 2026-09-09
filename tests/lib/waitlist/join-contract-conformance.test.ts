import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AREAS, OTHER_AREA } from "@/lib/constants";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import {
  REQUIRED_PROFILE_FIELDS,
  assessProfileCompleteness,
  completionDraftFromStored,
  completionPatchFromProfile,
  emptyJoinProfileDraft,
  invitationEligibility,
  validateWaitlistJoinProfile,
  PROFILE_COMPLETE,
  PROFILE_INCOMPLETE,
} from "@/lib/waitlist/join-profile";
import {
  TREATMENT_AREA_IDS,
  TREATMENT_AREA_LABEL,
  parseTreatmentAreaIds,
} from "@/lib/waitlist/treatment-area-catalog";

// ===========================================================================
// THE AGREED JOIN CONTRACT, ASSERTED IN ONE PLACE
// ===========================================================================
//
// One test per clause of the product contract, so a reviewer can map the
// agreement to evidence without reconstructing it from four files. The DEEP
// coverage of each clause lives in the module's own suite; this file is the
// index, and it fails if any clause stops holding.
// ===========================================================================

const COMPLETE = {
  firstName: "Sarah",
  lastName: "Jones",
  email: "sarah@example.com",
  mobile: "07700900123",
  treatmentAreaIds: ["chin"],
  availabilityPreference: "both",
} as const;

function submitted(over: Record<string, unknown> = {}) {
  return validateWaitlistJoinProfile({ ...COMPLETE, smsOperationalConsent: false, ...over });
}

describe("CLAUSE — first name and last name are separate required fields", () => {
  it("both are required, independently", () => {
    expect(REQUIRED_PROFILE_FIELDS).toContain("firstName");
    expect(REQUIRED_PROFILE_FIELDS).toContain("lastName");
    expect(submitted({ firstName: "" }).ok).toBe(false);
    expect(submitted({ lastName: "" }).ok).toBe(false);
    expect(submitted().ok).toBe(true);
  });
});

describe("CLAUSE — email is required", () => {
  it("refuses a missing or malformed address, accepts a valid one", () => {
    expect(REQUIRED_PROFILE_FIELDS).toContain("email");
    expect(submitted({ email: "" }).ok).toBe(false);
    expect(submitted({ email: "nope" }).ok).toBe(false);
    expect(submitted().ok).toBe(true);
  });
});

describe("CLAUSE — mobile is required", () => {
  it("is structurally required, not merely encouraged", () => {
    expect(REQUIRED_PROFILE_FIELDS).toContain("mobile");
    const blank = submitted({ mobile: "" });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.mobile).toBeTruthy();
  });

  it("a ticked SMS consent does NOT excuse a missing mobile", () => {
    // The two are independent: consent is not a substitute for a number, and a
    // number is not consent.
    expect(submitted({ mobile: "", smsOperationalConsent: true }).ok).toBe(false);
  });

  it("an incomplete row is missing `mobile` where the legacy entry had none", () => {
    const legacy = assessProfileCompleteness({ legacyName: "Sarah Jones", email: "s@e.com" });
    expect(legacy.status).toBe(PROFILE_INCOMPLETE);
    if (legacy.status === PROFILE_INCOMPLETE) expect(legacy.missing).toContain("mobile");
  });
});

describe("CLAUSE — treatment areas are a controlled multi-select, no free text", () => {
  it("the catalog is exactly AREAS minus the public free-text 'Other'", () => {
    const labels = TREATMENT_AREA_IDS.map((id) => TREATMENT_AREA_LABEL[id]);
    expect([...labels].sort()).toEqual(
      [...AREAS.filter((a) => a !== OTHER_AREA)].sort(),
    );
    expect(labels).not.toContain(OTHER_AREA);
  });

  it("MULTI-select: more than one area is a valid answer", () => {
    expect(submitted({ treatmentAreaIds: ["chin", "neck", "back"] }).ok).toBe(true);
  });

  it("at least one area is required", () => {
    expect(submitted({ treatmentAreaIds: [] }).ok).toBe(false);
  });

  it("no arbitrary string can enter, and no free-text limb exists to catch it", () => {
    for (const bad of [["Other"], ["anything else"], ["Chin"], ["chin", "elbow"]]) {
      expect(parseTreatmentAreaIds(bad).ok).toBe(false);
      expect(submitted({ treatmentAreaIds: bad }).ok).toBe(false);
    }
  });

  it("the rendered picker offers checkboxes and no text input for an area", () => {
    const html = renderToStaticMarkup(
      createElement(WaitlistJoinForm, {
        studioName: "Willow",
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("<textarea");
    // Exactly four text-ish inputs: first, last, email, mobile. None for areas.
    expect((html.match(/type="(text|email|tel)"/g) ?? [])).toHaveLength(4);
  });
});

describe("CLAUSE — availability is weekdays / weekends / both, with NO default", () => {
  it("offers exactly the three structured answers", () => {
    for (const value of ["weekdays", "weekends", "both"]) {
      expect(submitted({ availabilityPreference: value }).ok).toBe(true);
    }
  });

  it("is unanswered until answered — on both drafts", () => {
    expect(emptyJoinProfileDraft().availabilityPreference).toBeNull();
    expect(
      completionDraftFromStored({ legacyName: "Sarah Jones" }).availabilityPreference,
    ).toBeNull();
  });

  it("refuses to proceed unanswered rather than assuming 'both'", () => {
    expect(submitted({ availabilityPreference: null }).ok).toBe(false);
  });

  it("renders no pre-selected radio", () => {
    const html = renderToStaticMarkup(
      createElement(WaitlistJoinForm, {
        studioName: "Willow",
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).not.toContain("checked=");
  });
});

describe("CLAUSE — SMS consent is collected, and declining costs nothing", () => {
  it("declining does NOT make a profile incomplete", () => {
    expect(REQUIRED_PROFILE_FIELDS).not.toContain("smsOperationalConsent");
    // Structural: the stored shape completeness reads has no consent limb AT
    // ALL, so consent cannot participate in the verdict even by mistake.
    expect(assessProfileCompleteness(COMPLETE).status).toBe(PROFILE_COMPLETE);
  });

  it("declining does NOT block a future Invite-to-book", () => {
    expect(invitationEligibility(COMPLETE).eligible).toBe(true);
  });

  it("a declined submission is still a valid, complete submission", () => {
    const declined = submitted({ smsOperationalConsent: false });
    expect(declined.ok).toBe(true);
    if (declined.ok) expect(declined.value.smsOperationalConsent).toBe(false);
  });
});

describe("CLAUSE — legacy entries stay honestly incomplete", () => {
  const legacy = { legacyName: "Sarah Jones", email: "sarah@example.com" };

  it("reads INCOMPLETE, naming only what is genuinely absent", () => {
    const assessed = assessProfileCompleteness(legacy);
    expect(assessed.status).toBe(PROFILE_INCOMPLETE);
    if (assessed.status !== PROFILE_INCOMPLETE) return;
    expect(assessed.missing).not.toContain("email"); // the one field they have
    expect([...assessed.missing].sort()).toEqual(
      ["availabilityPreference", "firstName", "lastName", "mobile", "treatmentAreaIds"].sort(),
    );
  });

  it("the combined name is NEVER guessed into first/last", () => {
    const draft = completionDraftFromStored(legacy);
    expect(draft.firstName).toBe("");
    expect(draft.lastName).toBe("");
  });

  it("and the guess is not made in the markup either", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: legacy,
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    expect(html).not.toContain('value="Sarah"');
    expect(html).not.toContain('value="Jones"');
  });
});

describe("CLAUSE — the public completion payload names neither the row nor the address", () => {
  it("carries no entryId, no email, no joinedAt", () => {
    const v = submitted();
    if (!v.ok) throw new Error("fixture invalid");
    const patch = completionPatchFromProfile(v.value, COMPLETE);
    for (const forbidden of ["entryId", "entry_id", "email", "joinedAt", "joined_at"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  it("and the completion surface renders no email control at all", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        stored: { legacyName: "Sarah Jones", email: "sarah@example.com" },
        onSubmit: async () => ({ ok: true }) as const,
      }),
    );
    // Not a disabled input — no control, so a forged post has nothing to fill.
    expect(html).not.toContain('type="email"');
    expect(html).toContain('data-testid="waitlist-field-email-locked"');
  });
});
