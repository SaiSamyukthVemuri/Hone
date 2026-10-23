// HIPAA-READY-01 (#828): what a mail client shows as an email's PREVIEW, and
// which forbidden facts it discloses. Shared by the preheader suites.
//
// A mail client builds its inbox and lock-screen preview from the first text it
// finds: in the HTML body for most clients, in the text part for plain-text
// ones. Clients that keep the preheader's invisible filler show only the
// preheader; clients that STRIP the filler show the preheader and then the
// start of the body. The rule below holds for the stripping clients too.

export const PREVIEW_CHARS = 140;

// The client's name, the service, a date or time (relative ones too), and an
// attendance or treatment fact. Every suite uses distinctive synthetic values.
export const FORBIDDEN: RegExp[] = [
  /Zephyrine/,
  /Electrolysis|Upper Lip/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(AM|PM)\b/,
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i,
  /\b2031\b/,
];

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&rsquo;/g, "’")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * The first PREVIEW_CHARS characters, extended to the end of the word the cut
 * lands in. A bare slice cut "Zephyrine" to "Zephyrin" and "treatment" to
 * "trea", so a leak straddling the boundary passed every pattern while a
 * client showing one more character displayed it.
 */
function wholeWordWindow(text: string): string {
  let end = Math.min(PREVIEW_CHARS, text.length);
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return text.slice(0, end);
}

/** What a filler-stripping client shows: the first visible text of <body>. */
export function simulatedPreview(html: string): string {
  const body = html.slice(html.search(/<body\b[^>]*>/i));
  const text = decode(
    body
      .replace(/<(style|title|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " "),
  );
  // Filler code points render as nothing; drop them and collapse whitespace.
  return wholeWordWindow(
    text
      .replace(/[ ﻿͏]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** What a plain-text client shows: the start of the text part. */
export function plainTextPreview(text: string): string {
  return wholeWordWindow(text.replace(/\s+/g, " ").trim());
}

/** The characters a client takes BEFORE any body text could appear. */
export function previewWindow(html: string): string {
  const body = html.slice(html.search(/<body\b[^>]*>/i));
  return decode(body.replace(/<[^>]+>/g, "")).slice(0, PREVIEW_CHARS);
}

/**
 * The forbidden facts a preview shows that its SUBJECT does not. The subject is
 * displayed beside the preview everywhere a preview is, and the subject rule
 * (tests/lib/email/subject-minimum-necessary.test.ts) already keeps the name,
 * service, date and time out of it; a fact the subject states (for example
 * "Appointment cancelled") is not disclosed a second time by the preview.
 */
export function previewLeaks(subject: string, preview: string): string[] {
  return FORBIDDEN.filter((re) => re.test(preview) && !re.test(subject)).map(String).sort();
}
