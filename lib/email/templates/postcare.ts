import { localTimeString } from "@/lib/booking/tz";

// Postcare email template (v1).
//
// All clinical content comes from per-studio settings (Hone does not
// invent medical advice). Hone provides the structure + safe defaults
// in the studio settings UI; this template renders whatever the studio
// has saved. Sections with empty studio text are simply omitted.
//
// The review prompt is intentionally neutral and is rendered only when
// the studio has set postcare_review_url. No discount logic, no review-
// reward tracking, no positive-only conditioning.
//
// Tone: post-treatment care information, not an emergency-care substitute.
// The footer explicitly encourages the client to contact the studio
// directly if something feels unusual or excessive.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

// Convert plain-text studio content to escaped HTML with line breaks
// preserved. Studios paste plain prose into Settings; the email renders
// it safely. Blank input yields an empty string (caller filters).
function textBlockToHtml(text: string | null | undefined): string {
  if (!text || text.trim().length === 0) return "";
  return escapeHtml(text).replace(/\n/g, "<br />");
}

// First name extraction. Falls back to the full name when there's no
// whitespace split. Used for the greeting only; the appointment record
// stores the full name.
function firstNameOf(fullName: string): string {
  const trimmed = fullName.trim();
  if (trimmed.length === 0) return "there";
  const first = trimmed.split(/\s+/)[0];
  return first || trimmed;
}

export type PostcareEmailInputs = {
  clientName: string;
  studioName: string;
  studioEmail: string;
  practitionerName: string | null;
  serviceName: string | null;
  startsAt: Date | null;
  timezone: string;
  aftercareText: string | null;
  warningSignsText: string | null;
  productRecommendationsText: string | null;
  reviewUrl: string | null;
};

export type PostcareEmail = {
  subject: string;
  html: string;
  text: string;
  // Plain-text preview the practitioner sees in the confirm modal
  // before sending. Strips HTML; same content as the text version.
  preview: string;
};

export function buildPostcareEmail(p: PostcareEmailInputs): PostcareEmail {
  const greetingName = firstNameOf(p.clientName);
  const studioLine = p.practitionerName
    ? `${p.practitionerName} at ${p.studioName}`
    : p.studioName;
  const appointmentLine = p.startsAt
    ? `${dayLabel(p.startsAt, p.timezone)} at ${localTimeString(
        p.startsAt,
        p.timezone,
      )}`
    : null;

  const aftercareHtml = textBlockToHtml(p.aftercareText);
  const warningHtml = textBlockToHtml(p.warningSignsText);
  const productsHtml = textBlockToHtml(p.productRecommendationsText);

  const subject = `Aftercare for your appointment with ${p.studioName}`;

  const htmlSections: string[] = [];
  htmlSections.push(
    `<p>Hi ${escapeHtml(greetingName)},</p>`,
    `<p>Thanks for coming in${
      appointmentLine ? ` on ${escapeHtml(appointmentLine)}` : ""
    }. Here's what to do for the next little while.</p>`,
  );
  if (p.serviceName) {
    htmlSections.push(
      `<p style="color:#6B6B6B;font-size:14px;">Service: ${escapeHtml(
        p.serviceName,
      )}</p>`,
    );
  }
  if (aftercareHtml) {
    htmlSections.push(
      `<h3 style="margin-top:24px;">Aftercare</h3>`,
      `<p>${aftercareHtml}</p>`,
    );
  }
  if (warningHtml) {
    htmlSections.push(
      `<h3 style="margin-top:24px;">What's not normal</h3>`,
      `<p>${warningHtml}</p>`,
    );
  }
  if (productsHtml) {
    htmlSections.push(
      `<h3 style="margin-top:24px;">Product recommendations</h3>`,
      `<p>${productsHtml}</p>`,
    );
  }
  htmlSections.push(
    `<p style="margin-top:24px;">If something feels unusual or excessive, contact ${escapeHtml(
      studioLine,
    )} directly. This email is post-treatment care information, not a substitute for medical advice or emergency care.</p>`,
  );
  htmlSections.push(
    `<p style="margin-top:16px;color:#6B6B6B;font-size:14px;">Contact: <a href="mailto:${escapeHtml(
      p.studioEmail,
    )}">${escapeHtml(p.studioEmail)}</a></p>`,
  );
  if (p.reviewUrl) {
    htmlSections.push(
      `<p style="margin-top:24px;font-size:14px;">If you had a good experience, reviews help small businesses. <a href="${escapeHtml(
        p.reviewUrl,
      )}">Leave a review</a>.</p>`,
    );
  }

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0A0A0A;line-height:1.55;">${htmlSections.join(
    "\n",
  )}</body></html>`;

  // Plain-text version + practitioner preview share the same content.
  const textSections: string[] = [];
  textSections.push(`Hi ${greetingName},`);
  textSections.push(
    `Thanks for coming in${
      appointmentLine ? ` on ${appointmentLine}` : ""
    }. Here's what to do for the next little while.`,
  );
  if (p.serviceName) {
    textSections.push(`Service: ${p.serviceName}`);
  }
  if (p.aftercareText && p.aftercareText.trim().length > 0) {
    textSections.push("", "Aftercare", p.aftercareText.trim());
  }
  if (p.warningSignsText && p.warningSignsText.trim().length > 0) {
    textSections.push("", "What's not normal", p.warningSignsText.trim());
  }
  if (
    p.productRecommendationsText &&
    p.productRecommendationsText.trim().length > 0
  ) {
    textSections.push(
      "",
      "Product recommendations",
      p.productRecommendationsText.trim(),
    );
  }
  textSections.push(
    "",
    `If something feels unusual or excessive, contact ${studioLine} directly. This email is post-treatment care information, not a substitute for medical advice or emergency care.`,
  );
  textSections.push(`Contact: ${p.studioEmail}`);
  if (p.reviewUrl) {
    textSections.push(
      "",
      `If you had a good experience, reviews help small businesses: ${p.reviewUrl}`,
    );
  }
  const text = textSections.join("\n");

  return { subject, html, text, preview: text };
}
