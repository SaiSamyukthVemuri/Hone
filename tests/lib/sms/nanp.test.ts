import { describe, expect, it } from "vitest";
import {
  CANADIAN_AREA_CODES,
  classifyNanpNumber,
  OTHER_NANP_AREA_CODES,
  TOLL_FREE_AREA_CODES,
} from "@/lib/sms/nanp";

// SMS-SENDER-READY-01: "+1" is shared by Canada and the US. The country comes
// from the area code, from explicit lists, and an unknown code falls to the
// STRICTER answer (US, which needs registration evidence), never to Canada.

describe("classifyNanpNumber", () => {
  it("Canadian area codes are Canadian", () => {
    for (const n of ["+14165550123", "+16045550123", "+15145550123", "+19025550123", "+18675550123", "+19425550123"]) {
      expect(classifyNanpNumber(n), n).toMatchObject({ ok: true, country: "CA" });
    }
  });

  it("US area codes, including US territories on +1, are US", () => {
    for (const n of ["+12125550123", "+13105550123", "+14155550123", "+17875550123", "+16715550123", "+13405550123"]) {
      expect(classifyNanpNumber(n), n).toMatchObject({ ok: true, country: "US" });
    }
  });

  it("other NANP members are neither", () => {
    for (const n of ["+18765550123", "+14415550123", "+12425550123", "+18095550123"]) {
      expect(classifyNanpNumber(n), n).toMatchObject({ ok: true, country: "other_nanp" });
    }
  });

  it("toll-free is its own kind", () => {
    for (const npa of TOLL_FREE_AREA_CODES) {
      expect(classifyNanpNumber(`+1${npa}5550123`)).toMatchObject({ ok: true, country: "toll_free" });
    }
  });

  it("an area code on no list is US, the stricter answer, never Canada", () => {
    expect(classifyNanpNumber("+12575550123")).toMatchObject({ ok: true, country: "US" });
  });

  it("refuses anything that is not a structurally valid +1 E.164 number", () => {
    expect(classifyNanpNumber("4165550123")).toEqual({ ok: false, reason: "not_e164_plus1" });
    expect(classifyNanpNumber("+1 416 555 0123")).toEqual({ ok: false, reason: "not_e164_plus1" });
    expect(classifyNanpNumber("+441632960123")).toEqual({ ok: false, reason: "not_e164_plus1" });
    expect(classifyNanpNumber(null)).toEqual({ ok: false, reason: "not_e164_plus1" });
    expect(classifyNanpNumber("+11165550123")).toEqual({ ok: false, reason: "invalid_area_code" });
    expect(classifyNanpNumber("+14115550123")).toEqual({ ok: false, reason: "invalid_area_code" });
    expect(classifyNanpNumber("+14161550123")).toEqual({ ok: false, reason: "invalid_exchange" });
  });

  it("the lists never overlap, and every entry is a valid area code", () => {
    const all = [...CANADIAN_AREA_CODES, ...OTHER_NANP_AREA_CODES, ...TOLL_FREE_AREA_CODES];
    expect(new Set(all).size).toBe(all.length);
    for (const npa of all) expect(npa, npa).toMatch(/^[2-9]\d\d$/);
    for (const npa of all) expect(npa, npa).not.toMatch(/^[2-9]11$/);
  });

  it("no known US area code is listed as Canadian (the unsafe direction)", () => {
    for (const us of ["212", "213", "310", "312", "415", "617", "646", "718", "917", "202", "305", "702"]) {
      expect(CANADIAN_AREA_CODES.has(us), us).toBe(false);
    }
  });
});
