import { describe, expect, it } from "vitest";
import {
  photoConsentSummary,
  reviewSignedRecord,
  type SignedConsentRecordLike,
} from "@/lib/consent/signed-record";

// P1-A: pure helpers for the photo-consent summary + the signed-record review
// warning. A DENIED photo response is a valid, answered choice (not missing).

const base: SignedConsentRecordLike = {
  template_title_snapshot: "Photo consent",
  template_body_snapshot: "I understand my photos may be used as described.",
  template_version: 1,
  template_hash: "a".repeat(64),
  signature_name: "Jane Client",
  signed_at: "2026-07-01T10:00:00Z",
  response: "accepted",
  response_label_snapshot: "I consent to photo use as described above.",
};

describe("photoConsentSummary: the four required outcomes", () => {
  it("granted → Photo use consented (ok)", () => {
    expect(photoConsentSummary("granted")).toEqual({ label: "Photo use consented", tone: "ok" });
  });
  it("denied → Photo use not consented (warn)", () => {
    expect(photoConsentSummary("denied")).toEqual({ label: "Photo use not consented", tone: "warn" });
  });
  it("not answered / not signed → Photo consent not completed", () => {
    expect(photoConsentSummary("not_answered").label).toBe("Photo consent not completed");
    expect(photoConsentSummary("not_signed").label).toBe("Photo consent not completed");
  });
  it("outdated / null / unexpected → needs review (never an implied grant)", () => {
    expect(photoConsentSummary("outdated").label).toBe("Consent response unavailable: needs review");
    expect(photoConsentSummary(null).label).toBe("Consent response unavailable: needs review");
    expect(photoConsentSummary("signed").label).toBe("Consent response unavailable: needs review");
  });
});

describe("reviewSignedRecord: valid vs needs-review", () => {
  it("accepts a complete photo-consent record", () => {
    expect(reviewSignedRecord(base, "photo_consent")).toEqual({ ok: true });
  });
  it("accepts a denied photo-consent record (denied is valid, not malformed)", () => {
    expect(reviewSignedRecord({ ...base, response: "denied" }, "photo_consent").ok).toBe(true);
  });
  it("accepts a complete non-photo record regardless of response", () => {
    expect(reviewSignedRecord({ ...base, response: "accepted" }, "treatment_consent").ok).toBe(true);
  });
  it("flags a blank form body for review", () => {
    const r = reviewSignedRecord({ ...base, template_body_snapshot: "   " }, "photo_consent");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.warning).toMatch(/form text/i);
  });
  it("flags a blank signature for review", () => {
    const r = reviewSignedRecord({ ...base, signature_name: "" }, "treatment_consent");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.warning).toMatch(/signature/i);
  });
  it("flags an unknown photo-consent response for review (not a silent grant)", () => {
    const r = reviewSignedRecord({ ...base, response: "maybe" }, "photo_consent");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.warning).toMatch(/needs review/i);
    // A null response on a photo form is also review-worthy.
    expect(reviewSignedRecord({ ...base, response: null }, "photo_consent").ok).toBe(false);
  });
});
