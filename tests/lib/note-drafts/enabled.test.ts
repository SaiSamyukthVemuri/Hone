import { describe, expect, it } from "vitest";
import { noteDraftsEnabledFor } from "@/lib/note-drafts/enabled";
import { sanitizeDraftFields } from "@/lib/note-drafts/sanitize";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

describe("note drafts switch (server-only allow-list, default OFF)", () => {
  it("is OFF when unset, empty or malformed", () => {
    for (const raw of [undefined, "", "   ", "true", "1", "*", "not-a-uuid"]) expect(noteDraftsEnabledFor(S1, raw)).toBe(false);
  });
  it("is ON only for a listed studio", () => {
    expect(noteDraftsEnabledFor(S1, `${S1}, ${S2}`)).toBe(true);
    expect(noteDraftsEnabledFor(S2, S1)).toBe(false);
    expect(noteDraftsEnabledFor(S1.toUpperCase(), S1)).toBe(true);
  });
  it("an invalid studio id is never enabled", () => {
    expect(noteDraftsEnabledFor("x", "x")).toBe(false);
  });
});

describe("sanitizeDraftFields", () => {
  it("keeps only known fields, drops the rest, enforces the final note's caps", () => {
    expect(sanitizeDraftFields("consultation", { body: "a", areas: ["x"], occurred_at: "2026-11-28", evil: "y" })).toEqual({ body: "a", areas: ["x"], occurred_at: "2026-11-28" });
    expect(sanitizeDraftFields("consultation", { body: "x".repeat(20001) })).toBeNull();
    expect(sanitizeDraftFields("skin_hair_analysis", { areas: Array.from({ length: 41 }, () => "a") })).toBeNull();
    expect(sanitizeDraftFields("budget", { budget_level: "somewhat_limited", budget_notes: "n", body: "ignored" })).toEqual({ budget_level: "somewhat_limited", budget_notes: "n" });
    expect(sanitizeDraftFields("consultation", [])).toBeNull();
    expect(sanitizeDraftFields("consultation", { body: 5 })).toBeNull();
  });
});
