import { escapeHtml } from "@/lib/email/markdown-lite";
import { leadAnchorId, type PlatformLeadKind } from "./alert-status";

// ===========================================================================
// LEAD-ALERT-01 (#826): the operator alert email for one new Hone lead
// ===========================================================================
//
// WHAT IT CARRIES: the minimum useful prospect data -- name and contact,
// practice, city, practice type, practitioner count, the current tool when one
// was given, the event and its time, and an authenticated console link. The
// free-text NOTES are left out: the email says only whether there are any, and
// the console is where they are read.
//
// SUBMITTED TEXT IS UNTRUSTED, so every value is flattened before it is used:
// control characters (CR and LF included) become spaces, invisible and
// direction-changing characters are removed, runs of whitespace collapse, and
// the length is capped. A value can therefore never start a new line of its
// own (no fake "Console:" line), reorder what is displayed, or flood the
// message. The HTML part then escapes it. The SUBJECT carries no submitted text
// at all, only the event and the time.
//
// DETERMINISTIC: the output is a pure function of the lead and the configured
// console origin -- no clock, no attempt number -- because every retry of one
// alert reuses one provider idempotency key, and the provider refuses a key
// presented with a different payload.
// ===========================================================================

export type PlatformLeadAlertContent = {
  kind: PlatformLeadKind;
  leadId: string;
  /** The lead's created_at (ISO). */
  eventAt: string;
  name: string | null;
  email: string | null;
  practiceName: string | null;
  location: string | null;
  practiceType: string | null;
  practitionerCount: string | null;
  currentTool: string | null;
  hasNotes: boolean;
};

export type RenderedPlatformLeadAlert = {
  subject: string;
  text: string;
  html: string;
};

/** The longest any submitted value may run in the alert. */
export const SUBMITTED_TEXT_MAX = 200;

// C0 and C1 controls, CR and LF included.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// bidirectional marks, line and paragraph separators, embeddings, overrides and
// isolates, word joiners and invisible operators, the BOM, interlinear
// annotation.
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Flatten one submitted value to a single, visible, bounded line, or null. */
export function cleanSubmittedText(
  value: unknown,
  max: number = SUBMITTED_TEXT_MAX,
): string | null {
  if (typeof value !== "string") return null;
  const flat = value
    .normalize("NFC")
    .replace(CONTROL, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) return null;
  // Code points, not UTF-16 units, so a cut never splits a character.
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}\u2026`;
}

const PRACTICE_TYPE_LABELS: Record<string, string> = {
  electrolysis: "Electrolysis only",
  laser: "Laser only",
  both: "Electrolysis and laser",
};

const PRACTITIONER_COUNT_LABELS: Record<string, string> = {
  "1": "1",
  "2-5": "2 to 5",
  "5+": "More than 5",
};

const NOT_GIVEN = "Not given";

/** "2026-10-11 18:05 UTC": the event's own time, never the sending time. */
export function formatEventTime(eventAt: string): string {
  const at = new Date(eventAt);
  if (Number.isNaN(at.getTime())) return "Time not recorded";
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The authenticated console link: the configured origin, never the request's. */
export function leadConsoleUrl(
  appOrigin: string,
  kind: PlatformLeadKind,
  leadId: string,
): string {
  return `${appOrigin.replace(/\/+$/, "")}/admin#${leadAnchorId(kind, leadId)}`;
}

type Line = { label: string; value: string };

function lines(c: PlatformLeadAlertContent): Line[] {
  const value = (v: unknown) => cleanSubmittedText(v) ?? NOT_GIVEN;
  if (c.kind === "early_access") {
    const out: Line[] = [
      { label: "Event", value: "Early-access signup" },
      { label: "Email", value: value(c.email) },
    ];
    const practice = cleanSubmittedText(c.practiceName);
    if (practice) out.push({ label: "Practice", value: practice });
    out.push({ label: "Received", value: formatEventTime(c.eventAt) });
    return out;
  }

  const practiceType = cleanSubmittedText(c.practiceType);
  const count = cleanSubmittedText(c.practitionerCount);
  const out: Line[] = [
    { label: "Event", value: "Demo request" },
    { label: "Name", value: value(c.name) },
    { label: "Email", value: value(c.email) },
    { label: "Practice", value: value(c.practiceName) },
    { label: "City", value: value(c.location) },
    {
      label: "Practice type",
      value: practiceType ? (PRACTICE_TYPE_LABELS[practiceType] ?? practiceType) : NOT_GIVEN,
    },
    {
      label: "Practitioners",
      value: count ? (PRACTITIONER_COUNT_LABELS[count] ?? count) : NOT_GIVEN,
    },
  ];
  const tool = cleanSubmittedText(c.currentTool);
  if (tool) out.push({ label: "Current tool", value: tool });
  if (c.hasNotes) {
    out.push({ label: "Notes", value: "Included with the request. Read them in the console." });
  }
  out.push({ label: "Received", value: formatEventTime(c.eventAt) });
  return out;
}

export function renderPlatformLeadAlert(
  c: PlatformLeadAlertContent,
  consoleUrl: string,
): RenderedPlatformLeadAlert {
  const event = c.kind === "demo_request" ? "demo request" : "early-access signup";
  const subject = `New Hone ${event} (${formatEventTime(c.eventAt)})`;
  const intro = `A new Hone ${event} was saved.`;
  const footer =
    "This alert went only to the Hone operator. Nothing was sent to the prospect.";
  const rows = lines(c);

  const text = [
    intro,
    "",
    ...rows.map((r) => `${r.label}: ${r.value}`),
    "",
    "Open it in the admin console (sign-in required):",
    consoleUrl,
    "",
    footer,
    "",
  ].join("\n");

  const cell = "padding:4px 12px 4px 0;vertical-align:top;";
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<table role="presentation" style="border-collapse:collapse;">`,
    ...rows.map(
      (r) =>
        `<tr><th scope="row" style="${cell}text-align:left;font-weight:600;">${escapeHtml(r.label)}</th>` +
        `<td style="${cell}">${escapeHtml(r.value)}</td></tr>`,
    ),
    `</table>`,
    `<p><a href="${escapeHtml(consoleUrl)}">Open it in the admin console</a> (sign-in required).</p>`,
    `<p style="color:#666;">${escapeHtml(footer)}</p>`,
  ].join("\n");

  return { subject, text, html };
}
