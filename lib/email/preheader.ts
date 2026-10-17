// HIPAA-READY-01 (#828): the hidden email PREHEADER.
//
// A mail client's inbox and lock-screen preview is built from the first text it
// finds in the HTML body. Hone's templates had no preheader, so the preview was
// the opening body text: appointment details, the service, the time, sometimes
// the client's name. This module puts a neutral line first, then invisible
// filler so the preview cannot run on into the body.
//
// What this is NOT: it does not make an email PHI-free. The body, the
// recipient address, the From line and the provider's own records are
// unchanged, and plain-text-only clients still preview the text part. See
// docs/security/email-provider-visible-inventory.md.
//
// Content rule (same as the subject rule in docs/08): the preheader never
// carries the client's name, the service, a date or time (relative ones too),
// or an attendance or treatment fact. The studio name is allowed: the From
// line already shows it.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Neutral preheader for a client-facing email. */
export function clientPreheader(studioName: string | null | undefined): string {
  const studio = studioName?.trim();
  return studio
    ? `A message from ${studio}. Open it to see the details.`
    : "Open this message to see the details.";
}

/** Neutral preheader for a studio-facing (practitioner or owner) email. */
export function studioPreheader(studioName: string | null | undefined): string {
  const studio = studioName?.trim();
  return studio
    ? `New activity at ${studio} in Hone. Open it to see the details.`
    : "New activity in Hone. Open it to see the details.";
}

// Zero-width and figure-space filler: renders as nothing, but fills the
// client's preview length so body text is not appended to the preheader.
const FILLER = "&#8199;&#65279;&#847; ".repeat(90);

const HIDDEN =
  "display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;";

/** The hidden preheader block, escaped. */
export function preheaderBlock(preheader: string): string {
  return (
    `<div data-hone-preheader style="${HIDDEN}">${escapeHtml(preheader)}</div>` +
    `<div style="${HIDDEN}">${FILLER}</div>`
  );
}

/**
 * Insert the preheader as the first content of <body>. If the document has no
 * <body> tag, the block goes first, so the preheader is still the first text.
 */
export function withPreheader(html: string, preheader: string): string {
  const block = preheaderBlock(preheader);
  const m = /<body\b[^>]*>/i.exec(html);
  if (!m) return block + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + block + html.slice(at);
}
