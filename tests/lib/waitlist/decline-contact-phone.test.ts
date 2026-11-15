import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_PHONE_PROBLEM_COPY,
  CONTACT_PHONE_SHAPE,
  PHONE_MASK_DIGITS,
  maskOnFilePhone,
  onFileHintText,
  resolveContactChoice,
  validateDeclineContactPhone,
} from "@/lib/waitlist/decline-contact-phone";

// HON-7 0328, independent part: pure phone rules for the "None of these times work" response. Synthetic numbers only.
// SENTINEL is a number nobody owns; no output may carry its digits except the masked hint's last four.
const SENTINEL_TYPED = "(647) 555-0187";
const SENTINEL_TYPED_DIGITS = "6475550187";
const ON_FILE = "+16475550142";

describe("validateDeclineContactPhone", () => {
  it("accepts a valid number and returns the stored E.164 shape", () => {
    expect(validateDeclineContactPhone(SENTINEL_TYPED)).toEqual({ ok: true, e164: "+16475550187" });
    expect(validateDeclineContactPhone("1-647-555-0187")).toEqual({ ok: true, e164: "+16475550187" });
    expect(validateDeclineContactPhone("+44 7700 900123")).toEqual({ ok: true, e164: "+447700900123" });
  });

  it("every accepted number matches the 0328 stored shape and length", () => {
    for (const raw of [SENTINEL_TYPED, "647 555 0187", "+447700900123", "+819012345678"]) {
      const r = validateDeclineContactPhone(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(CONTACT_PHONE_SHAPE.test(r.e164)).toBe(true);
        expect(r.e164.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it("refuses blank, non-string, too-long and unusable numbers by class", () => {
    expect(validateDeclineContactPhone("")).toEqual({ ok: false, problem: "required" });
    expect(validateDeclineContactPhone("   ")).toEqual({ ok: false, problem: "required" });
    expect(validateDeclineContactPhone(null)).toEqual({ ok: false, problem: "required" });
    expect(validateDeclineContactPhone(5551234567)).toEqual({ ok: false, problem: "required" });
    expect(validateDeclineContactPhone("1".repeat(41))).toEqual({ ok: false, problem: "too_long" });
    expect(validateDeclineContactPhone("12345")).toEqual({ ok: false, problem: "invalid" });
    expect(validateDeclineContactPhone("not a number")).toEqual({ ok: false, problem: "invalid" });
    expect(validateDeclineContactPhone("(647) 555-018")).toEqual({ ok: false, problem: "invalid" });
  });

  it("refuses a leading-zero country code that the sender's rule alone would pass", () => {
    expect(validateDeclineContactPhone("+0123456789")).toEqual({ ok: false, problem: "invalid" });
  });

  it("a failure carries a class only: no digit of the typed number appears in the result or its copy", () => {
    for (const raw of ["(647) 555-018", "+0647555018", "6475550187".repeat(5)]) {
      const r = validateDeclineContactPhone(raw);
      expect(r.ok).toBe(false);
      const blob = JSON.stringify(r) + Object.values(CONTACT_PHONE_PROBLEM_COPY).join("|");
      expect(blob).not.toMatch(/\d/);
    }
  });
});

describe("maskOnFilePhone", () => {
  it("shows only the last four digits, built from a usable number in any stored shape", () => {
    for (const stored of [ON_FILE, "647-555-0142", "(647) 555 0142", "16475550142"]) {
      expect(maskOnFilePhone(stored)).toEqual({ available: true, lastDigits: "0142" });
    }
    expect(PHONE_MASK_DIGITS).toBe(4);
    expect(onFileHintText(maskOnFilePhone(ON_FILE))).toBe("the number ending 0142");
  });

  it("the hint never carries more than the mask length of digits", () => {
    const hint = maskOnFilePhone(ON_FILE);
    const text = onFileHintText(hint) ?? "";
    expect(JSON.stringify(hint).replace(/\D/g, "")).toBe("0142");
    expect(text.replace(/\D/g, "")).toBe("0142");
  });

  it("is not available for blank, malformed or non-string values (the form then asks for a number)", () => {
    for (const bad of [null, undefined, "", "   ", "abc", "12345", 6475550142, {}]) {
      expect(maskOnFilePhone(bad)).toEqual({ available: false });
      expect(onFileHintText(maskOnFilePhone(bad))).toBeNull();
    }
  });
});

describe("resolveContactChoice", () => {
  it("confirming the on-file number copies nothing", () => {
    const r = resolveContactChoice({ useOnFile: true }, ON_FILE);
    expect(r).toEqual({ ok: true, kind: "on_file" });
    expect(JSON.stringify(r)).not.toMatch(/\d/);
  });

  it("a typed number is returned normalized and used instead of the on-file one", () => {
    expect(resolveContactChoice({ contactPhone: SENTINEL_TYPED }, ON_FILE)).toEqual({ ok: true, kind: "typed", e164: "+16475550187" });
    expect(resolveContactChoice({ useOnFile: false, contactPhone: SENTINEL_TYPED }, null)).toEqual({ ok: true, kind: "typed", e164: "+16475550187" });
  });

  it("both, or neither, is refused", () => {
    expect(resolveContactChoice({ useOnFile: true, contactPhone: SENTINEL_TYPED }, ON_FILE)).toEqual({ ok: false, problem: "choose_one" });
    expect(resolveContactChoice({}, ON_FILE)).toEqual({ ok: false, problem: "choose_one" });
    expect(resolveContactChoice({ useOnFile: false, contactPhone: "  " }, ON_FILE)).toEqual({ ok: false, problem: "choose_one" });
  });

  it("with nothing usable on file a number is required, and confirming nothing is refused", () => {
    expect(resolveContactChoice({}, null)).toEqual({ ok: false, problem: "required" });
    expect(resolveContactChoice({ useOnFile: true }, null)).toEqual({ ok: false, problem: "no_number_on_file" });
    expect(resolveContactChoice({ useOnFile: true }, "12345")).toEqual({ ok: false, problem: "no_number_on_file" });
  });

  it("only the literal true confirms", () => {
    for (const v of ["true", 1, "yes", {}, [], "on"]) {
      expect(resolveContactChoice({ useOnFile: v }, ON_FILE)).toEqual({ ok: false, problem: "choose_one" });
    }
  });

  it("a typed number that is invalid is refused by class, value-free", () => {
    const r = resolveContactChoice({ contactPhone: "(647) 555-018" }, ON_FILE);
    expect(r).toEqual({ ok: false, problem: "invalid" });
    expect(JSON.stringify(r)).not.toMatch(/\d/);
  });

  it("no result for any input carries the typed number's digits", () => {
    const inputs = [
      resolveContactChoice({ contactPhone: SENTINEL_TYPED, useOnFile: true }, ON_FILE),
      resolveContactChoice({ contactPhone: "6475550187x" }, ON_FILE),
      resolveContactChoice({ useOnFile: true }, ON_FILE),
    ];
    for (const r of inputs) {
      if (!r.ok) expect(JSON.stringify(r)).not.toContain(SENTINEL_TYPED_DIGITS);
    }
  });
});

describe("the independent part stays unwired", () => {
  // The 0328 app change removes this block when it wires the module. It must not be called from the action, the form or any page until the 0328 migration is applied and read back (rollout order B1).
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("no application file imports decline-contact-phone", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => walk(join(process.cwd(), d)))
      .filter((f) => !f.endsWith("lib/waitlist/decline-contact-phone.ts"))
      .filter((f) => /decline-contact-phone/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("the module imports nothing that stores, sends or reads a database", () => {
    const src = readFileSync(join(process.cwd(), "lib/waitlist/decline-contact-phone.ts"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./signup-contact", "@/lib/sms/phone"]);
    expect(src).not.toMatch(/supabase|fetch\(|console\./);
  });
});
