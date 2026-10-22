import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostcarePreviewModal } from "@/app/(app)/settings/studio/PostcareEditingHelpers";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";

// The owner's postcare preview must show the subject the client actually
// receives. #859 changed the sent subject to a minimum-necessary one; the
// preview kept the old treatment-revealing wording (Willow peer review of
// #1049, F1), so the owner was shown a subject no client ever gets.

function previewText(studioName: string): string {
  const html = renderToStaticMarkup(
    createElement(PostcarePreviewModal, {
      studioName,
      contactEmail: null,
      ownerFallbackEmail: "owner@example.test",
      aftercareText: "",
      warningSignsText: "",
      productRecommendationsText: "",
      reviewUrl: "",
      reviewPromptText: "",
      onClose: () => {},
    }),
  );
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function sentSubject(studioName: string): string {
  return buildPostcareEmail({
    clientName: "Synthetic Client",
    studioName,
    studioEmail: null,
    practitionerName: null,
    serviceName: null,
    startsAt: null,
    timezone: "America/Toronto",
    aftercareText: null,
    warningSignsText: null,
    productRecommendationsText: null,
    reviewUrl: null,
  }).subject;
}

describe("postcare preview subject matches the sent subject", () => {
  it("shows exactly the subject the sender uses", () => {
    expect(previewText("Studio Synthetica")).toContain(`Subject: ${sentSubject("Studio Synthetica")}`);
  });
  it("never shows the treatment-revealing wording", () => {
    expect(previewText("Studio Synthetica")).not.toMatch(/aftercare for your appointment/i);
  });
  it("falls back to a neutral studio label before a name is saved", () => {
    expect(previewText("")).toContain(`Subject: ${sentSubject("your studio")}`);
  });
});
