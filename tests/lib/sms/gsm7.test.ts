import { describe, expect, it } from "vitest";
import { GSM7_BASIC, GSM7_EXTENSION, GSM7_SEGMENT_UNITS, gsm7CharUnits, gsm7Units } from "@/lib/sms/gsm7";

// The GSM-7 alphabet (3GPP TS 23.038 default alphabet) the SMS-04 join text is
// budgeted in. 128 basic code points less ESC = 127 characters; the extension
// table has 10 (FF ^ { } \ [ ~ ] | €).
describe("the GSM-7 alphabet", () => {
  it("has the standard's sizes, with no duplicates and no overlap", () => {
    const basic = [...GSM7_BASIC];
    const ext = [...GSM7_EXTENSION];
    expect(basic).toHaveLength(127);
    expect(new Set(basic).size).toBe(127);
    expect(ext).toHaveLength(10);
    expect(ext.filter((c) => basic.includes(c))).toEqual([]);
    expect(GSM7_SEGMENT_UNITS).toBe(160);
  });

  it("counts one unit for the basic set, two for the extension table, and refuses the rest", () => {
    for (const c of ["A", "z", "0", " ", "É", "é", "è", "Ø", "Ñ", "ß", "Δ", "£", "¤", "§", "¿", "à"]) {
      expect(gsm7CharUnits(c), c).toBe(1);
    }
    for (const c of ["[", "]", "{", "}", "|", "~", "^", "\\", "€"]) expect(gsm7CharUnits(c), c).toBe(2);
    for (const c of ["ç", "ê", "á", "ú", "’", "“", "–", "…", "✨", "美", "`"]) expect(gsm7CharUnits(c), c).toBeNull();
  });

  it("measures a text, and refuses it whole when any character is outside", () => {
    expect(gsm7Units("")).toBe(0);
    // "Élan" 4, " " 1, "[Spa]" 2+3+2, " " 1, "€5" 2+1
    expect(gsm7Units("Élan [Spa] €5")).toBe(4 + 1 + 7 + 1 + 3);
    expect(gsm7Units("Façade")).toBeNull();
  });
});
