// The GSM-7 alphabet (3GPP TS 23.038 default alphabet), as carriers count it.
//
// A single SMS segment holds 160 GSM-7 units (septets). A character from the
// BASIC set costs one unit; a character from the EXTENSION table is sent as
// ESC + character and costs two. Any character outside both forces the whole
// message into UCS-2, whose single segment holds 70 characters.
//
// Used by the SMS-04 join text's sender label (lib/sms/templates.ts), which
// must keep the WHOLE message in one GSM-7 segment.

/** The basic set: one unit each. LF and CR are here; ESC is not a character. */
export const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** The extension table, reached through ESC: two units each. */
export const GSM7_EXTENSION = "\f^{}\\[~]|€";

/** One GSM-7 segment. */
export const GSM7_SEGMENT_UNITS = 160;

const BASIC = new Set(GSM7_BASIC);
const EXTENSION = new Set(GSM7_EXTENSION);

/** The units one character costs in GSM-7, or null when it is not GSM-7. */
export function gsm7CharUnits(ch: string): 1 | 2 | null {
  if (BASIC.has(ch)) return 1;
  if (EXTENSION.has(ch)) return 2;
  return null;
}

/** The units a text needs in GSM-7, or null when any character is outside GSM-7. */
export function gsm7Units(text: string): number | null {
  let units = 0;
  for (const ch of text) {
    const u = gsm7CharUnits(ch);
    if (u === null) return null;
    units += u;
  }
  return units;
}
