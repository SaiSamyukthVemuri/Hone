import { describe, expect, it } from "vitest";
import { redeemedUnbookedEntries } from "@/lib/waitlist/needs-attention";

const row = (id: string, status: string) => ({ id, name: id, joined_at: "2026-11-01T00:00:00Z", status });

describe("redeemedUnbookedEntries", () => {
  it("lists only invited entries whose invitation was redeemed", () => {
    const rows = [row("a", "invited"), row("b", "invited"), row("c", "waiting"), row("d", "converted")];
    const cycles = new Map([
      ["a", { redeemed: true }],
      ["b", { redeemed: false }],
      ["c", { redeemed: true }],
      ["d", { redeemed: true }],
    ]);
    expect(redeemedUnbookedEntries(rows, cycles)?.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps the incoming (joined_at, id) order", () => {
    const rows = [row("z", "invited"), row("m", "invited")];
    const cycles = new Map([["z", { redeemed: true }], ["m", { redeemed: true }]]);
    expect(redeemedUnbookedEntries(rows, cycles)?.map((r) => r.id)).toEqual(["z", "m"]);
  });

  it("returns null when the facts are unknown, never an empty list", () => {
    expect(redeemedUnbookedEntries([row("a", "invited")], null)).toBeNull();
  });
});
