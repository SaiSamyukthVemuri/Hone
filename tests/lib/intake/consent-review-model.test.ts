import { describe, expect, it } from "vitest";
import { buildConsentReviewModel } from "@/lib/intake/consent-review-model";
import type { IntakeConsentFormView } from "@/lib/intake/consent-forms";
import type { PortalPhotoConsentView } from "@/lib/consent/queries";

// Chloe, minutes after #545 shipped: "consent was both accepted and denied",
// "this should not be possible".
//
// Both records were real — an intake photo answer of Accepted at 3:56 PM and a
// portal answer of Consent denied at 3:57 PM. The defect was that the screen
// gave them equal authority. This suite pins the rule that fixes it: exactly
// one CURRENT answer per consent question, everything else history, and a
// "superseded" claim only where the records actually prove it.

const TREATMENT: IntakeConsentFormView = {
  templateId: "tmpl-treatment",
  formType: "treatment_consent",
  titleSnapshot: "Treatment Consent",
  bodySnapshot: "Treatment body the client read.",
  templateVersion: 1,
  response: "accepted",
  responseLabelSnapshot: null,
  respondedAtIso: "2026-08-09T15:56:00.000Z",
};

function photoIntake(
  over: Partial<IntakeConsentFormView> = {},
): IntakeConsentFormView {
  return {
    templateId: "tmpl-photo",
    formType: "photo_consent",
    titleSnapshot: "Photo Consent",
    bodySnapshot: "Photo body the client read.",
    templateVersion: 2,
    response: "accepted",
    responseLabelSnapshot: "I consent to photographs.",
    respondedAtIso: "2026-08-09T15:56:00.000Z",
    ...over,
  };
}

function portalPhoto(
  over: Partial<PortalPhotoConsentView> = {},
): PortalPhotoConsentView {
  const signedAt = "2026-08-09T15:57:00.000Z";
  return {
    templateId: "tmpl-photo",
    state: "denied",
    templateTitle: "Photo Consent",
    currentVersion: 2,
    record: {
      id: "sig-1",
      template_id: "tmpl-photo",
      template_title_snapshot: "Photo Consent",
      template_version: 2,
      signature_name: "Dana Reyes",
      signed_at: signedAt,
      response: "denied",
      template_body_snapshot: "Photo body.",
      response_label_snapshot: "I do NOT consent to photographs.",
      template_hash: "hash",
      created_at: signedAt,
    },
    ...over,
  } as PortalPhotoConsentView;
}

describe("consent review model — the partition", () => {
  it("treatment consent is CURRENT and never history: the intake still owns it", () => {
    const m = buildConsentReviewModel({
      intakeForms: [TREATMENT],
      portalPhotos: [],
    });
    expect(m.currentIntakeForms).toHaveLength(1);
    expect(m.currentIntakeForms[0].formType).toBe("treatment_consent");
    expect(m.history).toHaveLength(0);
  });

  it("an intake PHOTO answer is history and never current, even when it says Accepted", () => {
    // The exact shape of Chloe's complaint: a historical Accepted must not be
    // able to reach the current block at all.
    const m = buildConsentReviewModel({
      intakeForms: [TREATMENT, photoIntake({ response: "accepted" })],
      portalPhotos: [portalPhoto({ state: "denied" })],
    });
    expect(m.currentIntakeForms.map((f) => f.formType)).toEqual([
      "treatment_consent",
    ]);
    expect(m.history).toHaveLength(1);
    expect(m.history[0].form.formType).toBe("photo_consent");
    expect(m.history[0].form.response).toBe("accepted");
  });

  it("the current photo answer is the PORTAL one — Chloe's 3:56 Accept / 3:57 Deny case", () => {
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake({ response: "accepted" })],
      portalPhotos: [portalPhoto({ state: "denied" })],
    });
    expect(m.currentPortalPhotos).toHaveLength(1);
    expect(m.currentPortalPhotos[0].state).toBe("denied");
    // ...and the Accepted still exists, untouched, in history.
    expect(m.history[0].form.response).toBe("accepted");
    expect(m.history[0].form.respondedAtIso).toBe("2026-08-09T15:56:00.000Z");
  });
});

describe("consent review model — supersession is PROVEN, never assumed", () => {
  it("same template_id + a demonstrably newer portal answer = superseded", () => {
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake()],
      portalPhotos: [portalPhoto()],
    });
    expect(m.history[0].provenance).toBe("superseded_by_portal");
  });

  it("a DIFFERENT template_id never supersedes — that would be a fabricated claim", () => {
    // A different template id is a different consent question. Editing a
    // template versions it IN PLACE (update ... set version = version + 1
    // where id = $id), so a new id is genuinely a new form, not a new version.
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake({ templateId: "tmpl-legacy-photo" })],
      portalPhotos: [portalPhoto({ templateId: "tmpl-photo" })],
    });
    expect(m.history[0].provenance).toBe("no_longer_collected");
  });

  it("a live portal form with NO answer does not supersede anything", () => {
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake()],
      portalPhotos: [portalPhoto({ state: "not_answered", record: null })],
    });
    expect(m.history[0].provenance).toBe("no_longer_collected");
  });

  it("when the intake record has no timestamp, order is NOT provable — weaker claim", () => {
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake({ respondedAtIso: null })],
      portalPhotos: [portalPhoto()],
    });
    expect(m.history[0].provenance).toBe("also_answered_in_portal");
  });

  it("a portal answer OLDER than the intake answer is not 'newer' and must not say so", () => {
    // Client signs in the portal, then later completes an intake that still
    // asked for photo consent. The portal is still the operational authority,
    // but calling the intake record "superseded by a NEWER portal response"
    // would be false.
    const older = portalPhoto();
    (older.record as { signed_at: string }).signed_at =
      "2026-08-01T09:00:00.000Z";
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake({ respondedAtIso: "2026-08-09T15:56:00.000Z" })],
      portalPhotos: [older],
    });
    expect(m.history[0].provenance).toBe("also_answered_in_portal");
  });
});

describe("consent review model — multiple live photo templates (#545, preserved)", () => {
  it("two live templates stay two independent current answers", () => {
    const a = portalPhoto({ templateId: "tmpl-doc", state: "denied" });
    const b = portalPhoto({ templateId: "tmpl-mkt", state: "granted" });
    const m = buildConsentReviewModel({
      intakeForms: [],
      portalPhotos: [a, b],
    });
    expect(m.currentPortalPhotos).toHaveLength(2);
    expect(m.currentPortalPhotos.map((p) => p.state)).toEqual([
      "denied",
      "granted",
    ]);
  });

  it("history attaches to the template it actually answered, not to whichever came first", () => {
    const doc = portalPhoto({ templateId: "tmpl-doc", state: "denied" });
    const mkt = portalPhoto({ templateId: "tmpl-mkt", state: "granted" });
    // This old answer belongs to the MARKETING template.
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake({ templateId: "tmpl-mkt" })],
      portalPhotos: [doc, mkt],
    });
    expect(m.history).toHaveLength(1);
    expect(m.history[0].form.templateId).toBe("tmpl-mkt");
    expect(m.history[0].provenance).toBe("superseded_by_portal");
  });
});

describe("consent review model — nothing is ever destroyed", () => {
  it("every stored intake form appears exactly once, in exactly one section", () => {
    const forms = [
      TREATMENT,
      photoIntake({ templateId: "tmpl-photo" }),
      photoIntake({ templateId: "tmpl-legacy", response: "denied" }),
    ];
    const m = buildConsentReviewModel({
      intakeForms: forms,
      portalPhotos: [portalPhoto()],
    });
    expect(m.currentIntakeForms.length + m.history.length).toBe(forms.length);
    // Verbatim: the projection copies records, it does not rewrite them.
    expect(m.history.map((h) => h.form.response)).toEqual([
      "accepted",
      "denied",
    ]);
  });

  it("no live photo form at all: history survives and no portal requirement is invented", () => {
    const m = buildConsentReviewModel({
      intakeForms: [photoIntake()],
      portalPhotos: [],
    });
    expect(m.currentPortalPhotos).toHaveLength(0);
    expect(m.history).toHaveLength(1);
    expect(m.history[0].provenance).toBe("no_longer_collected");
  });
});
