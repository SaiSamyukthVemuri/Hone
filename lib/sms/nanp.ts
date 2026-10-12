// ===========================================================================
// SMS-SENDER-READY-01 (#824): which country a +1 number belongs to.
// ===========================================================================
//
// Canada and the United States share country code +1 (the North American
// Numbering Plan), so "+1" alone says nothing about whether a recipient or a
// sender number is Canadian or US. The difference matters: a US recipient of
// application-to-person SMS needs a sender that is REGISTERED for US traffic
// (10DLC brand and campaign, or a verified toll-free number), and that is a
// separate fact from a number existing or passing one test.
//
// THE RULE: classify by area code (NPA), from an explicit list, dated below.
//
//   * CANADA: the area codes the Canadian Numbering Administrator has put into
//     service, listed exactly. A Canadian area code missing from this list is
//     classified "US" — the STRICTER answer, since every US-bound path needs
//     registration evidence. Listing a US code as Canadian would be the unsafe
//     error, so the list holds only codes known to be Canadian.
//   * OTHER NANP: Caribbean and Atlantic members that are neither (Bahamas,
//     Jamaica, Bermuda, ...). Neither a Canadian nor a US sender assumption
//     applies; callers treat them as unsupported.
//   * TOLL-FREE (8XX): not geographic. A toll-free SENDER needs its own
//     verification; as a recipient it is not a mobile number.
//   * UNITED STATES: every other valid NPA, including US territories that use
//     +1 (Puerto Rico, USVI, Guam, Northern Mariana Islands, American Samoa).
//
// Pure: no I/O, no env, no clock. It never guesses a 10-digit number's country
// from anything except its area code, and it refuses anything that is not a
// structurally valid +1 E.164 number.
// ===========================================================================

/** The date this file's lists were last checked against the plan administrators. */
export const NANP_AREA_CODES_CHECKED = "2026-10-11";

/** Canadian geographic area codes in service (CNA). */
export const CANADIAN_AREA_CODES: ReadonlySet<string> = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289",
  "306", "343", "354", "365", "367", "368", "382",
  "403", "416", "418", "428", "431", "437", "438", "450", "468", "474",
  "506", "514", "519", "548", "579", "581", "584", "587",
  "604", "613", "639", "647", "672", "683",
  "705", "709", "742", "753", "778", "780", "782",
  "807", "819", "825", "867", "873", "879",
  "902", "905", "942",
]);

/** NANP members that are neither Canada nor the United States. */
export const OTHER_NANP_AREA_CODES: ReadonlySet<string> = new Set([
  "242", // Bahamas
  "246", // Barbados
  "264", // Anguilla
  "268", // Antigua and Barbuda
  "284", // British Virgin Islands
  "345", // Cayman Islands
  "441", // Bermuda
  "473", // Grenada
  "649", // Turks and Caicos
  "658", "876", // Jamaica
  "664", // Montserrat
  "721", // Sint Maarten
  "758", // Saint Lucia
  "767", // Dominica
  "784", // Saint Vincent and the Grenadines
  "809", "829", "849", // Dominican Republic
  "868", // Trinidad and Tobago
  "869", // Saint Kitts and Nevis
]);

export const TOLL_FREE_AREA_CODES: ReadonlySet<string> = new Set([
  "800", "833", "844", "855", "866", "877", "888",
]);

export type NanpCountry = "CA" | "US" | "other_nanp" | "toll_free";

export type NanpClassification =
  | { ok: true; e164: string; areaCode: string; country: NanpCountry }
  | { ok: false; reason: "not_e164_plus1" | "invalid_area_code" | "invalid_exchange" };

const PLUS1 = /^\+1(\d{3})(\d{3})(\d{4})$/;

/**
 * Classify a +1 E.164 number. Only `+1` followed by exactly ten digits is
 * accepted: callers normalize first (lib/sms/phone.ts), so formatting is never
 * reinterpreted here.
 */
export function classifyNanpNumber(e164: string | null | undefined): NanpClassification {
  const m = typeof e164 === "string" ? PLUS1.exec(e164) : null;
  if (!m) return { ok: false, reason: "not_e164_plus1" };
  const [, npa, nxx] = m;
  // NPA and exchange both start 2-9; N11 codes are service codes, never area codes.
  if (!/^[2-9]\d\d$/.test(npa) || /^[2-9]11$/.test(npa)) {
    return { ok: false, reason: "invalid_area_code" };
  }
  if (!/^[2-9]\d\d$/.test(nxx)) return { ok: false, reason: "invalid_exchange" };

  const country: NanpCountry = CANADIAN_AREA_CODES.has(npa)
    ? "CA"
    : OTHER_NANP_AREA_CODES.has(npa)
      ? "other_nanp"
      : TOLL_FREE_AREA_CODES.has(npa)
        ? "toll_free"
        : "US";
  return { ok: true, e164: m[0], areaCode: npa, country };
}
