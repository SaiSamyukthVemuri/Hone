import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, maskPreferredName } from "@/lib/clients/contact-audit";

// R5 parity vectors. The same JSON is the contract for the held 0290 SQL masks (tests/db draft); this file proves the TypeScript side.
type Row = { in: string | null; out: string };
const vectors = JSON.parse(readFileSync(path.resolve(__dirname, "../../fixtures/contact-mask-vectors.json"), "utf8")) as { email: Row[]; phone: Row[]; preferred_name: Row[] };

describe("contact mask parity vectors (TypeScript side)", () => {
  it("the table is read and covers each field with edge cases", () => {
    expect(vectors.email.length).toBeGreaterThanOrEqual(8);
    expect(vectors.phone.length).toBeGreaterThanOrEqual(8);
    expect(vectors.preferred_name.length).toBeGreaterThanOrEqual(7);
  });
  it.each(vectors.email)("email %j", ({ in: v, out }) => expect(maskEmail(v)).toBe(out));
  it.each(vectors.phone)("phone %j", ({ in: v, out }) => expect(maskPhone(v)).toBe(out));
  it.each(vectors.preferred_name)("preferred name %j", ({ in: v, out }) => expect(maskPreferredName(v)).toBe(out));
  it("no vector's mask contains its whole original value", () => {
    for (const [fn, rows] of [[maskEmail, vectors.email], [maskPhone, vectors.phone], [maskPreferredName, vectors.preferred_name]] as const) {
      for (const { in: v } of rows) {
        const t = (v ?? "").trim();
        if (t.length > 1) expect(fn(v), String(v)).not.toContain(t);
      }
    }
  });
});
