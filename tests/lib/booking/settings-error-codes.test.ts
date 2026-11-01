import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BOOKING_SETTINGS_ERROR_SENTENCES,
  BOOKING_SETTINGS_GENERIC_ERROR,
  bookingSettingsErrorSentence,
  bookingSettingsErrorUrl,
  type BookingSettingsErrorCode,
} from "@/lib/booking/settings-error-codes";

// F2. /settings/booking printed any `?error=` value verbatim: a crafted link
// could put any words in the studio's own red banner. The URL now carries a
// code and the page maps it.

const CODES = Object.keys(BOOKING_SETTINGS_ERROR_SENTENCES) as BookingSettingsErrorCode[];

describe("bookingSettingsErrorSentence", () => {
  it("maps every recognised code to its fixed sentence", () => {
    for (const code of CODES) expect(bookingSettingsErrorSentence(code)).toBe(BOOKING_SETTINGS_ERROR_SENTENCES[code]);
    expect(CODES.length).toBeGreaterThanOrEqual(13);
  });

  it("keeps the sentences the actions used before", () => {
    expect(bookingSettingsErrorSentence("slug_taken")).toBe("That slug is already taken. Pick another.");
    expect(bookingSettingsErrorSentence("timezone_conflict")).toMatch(/^Changing the timezone would push a blockout/);
    expect(bookingSettingsErrorSentence("save_failed")).toBe("Could not save your booking settings.");
    expect(bookingSettingsErrorSentence("duration_invalid")).toBe("Default duration must be between 5 and 480 minutes.");
    expect(bookingSettingsErrorSentence("buffer_invalid")).toMatch(/^Buffer must be one of: /);
  });

  const HOSTILE: Array<[string, unknown]> = [
    ["arbitrary text", "Your account is suspended. Call 555-0100 now"],
    ["URL-encoded text", "Your%20account%20is%20suspended"],
    ["double-encoded text", "slug%2520taken"],
    ["an encoded code", "slug%5Ftaken"],
    ["HTML-looking text", "<script>alert(1)</script>"],
    ["an image tag", '<img src=x onerror=alert(1)>'],
    ["an over-long value", "a".repeat(5000)],
    ["an over-long code-shaped value", "slug_taken".padEnd(200, "_")],
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a code with trailing text", "slug_taken extra"],
    ["an upper-case code", "SLUG_TAKEN"],
    ["a prototype key", "constructor"],
    ["another prototype key", "__proto__"],
    ["toString", "toString"],
    ["a number", 7],
    ["an object", { a: 1 }],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [name, value] of HOSTILE) {
    it(`shows the one generic sentence for ${name}`, () => {
      expect(bookingSettingsErrorSentence(value)).toBe(BOOKING_SETTINGS_GENERIC_ERROR);
    });
  }

  it("uses the first value of a repeated parameter and still maps it", () => {
    expect(bookingSettingsErrorSentence(["slug_taken", "free text"])).toBe(BOOKING_SETTINGS_ERROR_SENTENCES.slug_taken);
    expect(bookingSettingsErrorSentence(["free text", "slug_taken"])).toBe(BOOKING_SETTINGS_GENERIC_ERROR);
  });
});

describe("the redirect carries codes only", () => {
  it("every code produces a URL with a bare lower-case code, no encoding needed", () => {
    for (const code of CODES) {
      const url = bookingSettingsErrorUrl(code);
      expect(url).toBe(`/settings/booking?error=${code}`);
      expect(url).toMatch(/^\/settings\/booking\?error=[a-z_]+$/);
    }
  });

  it("the actions never build the error URL from text", () => {
    const src = readFileSync("app/(app)/settings/booking/actions.ts", "utf8");
    expect(src).not.toMatch(/encodeURIComponent/);
    expect(src).not.toMatch(/failureMessage/);
    expect(src.match(/\?error=/g)?.length ?? 0).toBe(1); // the comment only
  });

  it("the page does not render the raw parameter", () => {
    const page = readFileSync("app/(app)/settings/booking/BookingView.tsx", "utf8");
    expect(page).toContain("bookingSettingsErrorSentence(errorParam)");
    expect(page).not.toMatch(/error=\{errorParam\}|error=\{errorMessage \?\? null\}/);
  });
});
