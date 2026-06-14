// Pilot Love Loop V1 (PR #250). A tiny, MANUAL feedback layer so the
// supervised pilot (Chloe, Laura) can tell us, in one tap, whether
// Hone's highest-value treatment-memory moments are landing. It is NOT a
// referral engine, NOT growth automation, NOT AI, NOT marketing
// automation. It sends nothing on its own: every action is a plain
// mailto: link that opens the practitioner's OWN mail client, pre-filled
// with GENERIC, non-sensitive context only.
//
// Safety by construction: this builder takes ENUM inputs only (surface +
// intent). There is no free-form argument that could carry a client
// name, contact detail, treatment note, exposure detail, payment
// internal, Stripe id, raw token, or audit JSON — so none can ever reach
// the subject/body. The body invites the practitioner to add their own
// words; it is empty of any recorded data by default.

export type PilotSurface =
  | "before_today"
  | "daily_prep"
  | "follow_up_assistant"
  | "dashboard_pilot_learning";

export type PilotIntent =
  | "useful"
  | "not_useful"
  | "general"
  | "another_electrologist";

// The established in-app support address (used on the login page and in
// settings). The pilot inbox Sam reads.
export const PILOT_FEEDBACK_EMAIL = "hello@hone.care";

const SURFACE_LABELS: Record<PilotSurface, string> = {
  before_today: "Before Today",
  daily_prep: "Daily Prep Brief",
  follow_up_assistant: "Follow-up Assistant",
  dashboard_pilot_learning: "Pilot learning",
};

export function pilotSurfaceLabel(surface: PilotSurface): string {
  return SURFACE_LABELS[surface];
}

// Builds a safe mailto:hello@hone.care link. Subject identifies the
// surface; body carries only the surface name + the chosen sentiment,
// then a placeholder line the practitioner can fill in. No recorded data.
export function buildPilotFeedbackMailto(
  surface: PilotSurface,
  intent: PilotIntent,
): string {
  const label = SURFACE_LABELS[surface];
  let subject: string;
  let bodyLines: string[];

  switch (intent) {
    case "useful":
      subject = `Hone feedback: ${label}`;
      bodyLines = [`Surface: ${label}`, "Feedback: useful", "", "(Add any details here.)"];
      break;
    case "not_useful":
      subject = `Hone feedback: ${label}`;
      bodyLines = [`Surface: ${label}`, "Feedback: not really", "", "(Add any details here.)"];
      break;
    case "another_electrologist":
      subject = "Hone: another electrologist who might care about treatment memory";
      bodyLines = [
        "I know an electrologist who might care about treatment memory.",
        "",
        "(Add any details here.)",
      ];
      break;
    case "general":
      subject = `Hone feedback: ${label}`;
      bodyLines = [`Surface: ${label}`, "", "(Add any details here.)"];
      break;
  }

  // encodeURIComponent (not URLSearchParams) so spaces become %20, which
  // every mail client decodes correctly in a mailto body.
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    bodyLines.join("\n"),
  )}`;
  return `mailto:${PILOT_FEEDBACK_EMAIL}?${query}`;
}
