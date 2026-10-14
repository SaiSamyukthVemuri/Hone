import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_CANDIDATES, demoAdoptionInventory, demoOwnedNumbers } from "@/lib/sms/sender-controls-demo";
import { classifyNanpNumber } from "@/lib/sms/nanp";

// Codex P2 4274756044: each studio's fake account owns several candidate
// pairs over many area codes, so one collision cannot wedge its demo.

describe("demo candidates", () => {
  it("every candidate is a fictional 555-0150..0199 number in the right country", () => {
    for (let k = 0; k < 20; k += 1) {
      const studio = randomUUID();
      for (let i = 0; i < DEMO_CANDIDATES; i += 1) {
        const { CA, US } = demoAdoptionInventory(studio, i).numbers;
        for (const [n, country] of [[CA.phoneNumber, "CA"], [US.phoneNumber, "US"]] as const) {
          const c = classifyNanpNumber(n);
          expect(c.ok && c.country, n).toBe(country);
          expect(n.slice(5, 8), n).toBe("555");
          const line = Number(n.slice(-4));
          expect(line).toBeGreaterThanOrEqual(150);
          expect(line).toBeLessThanOrEqual(199);
        }
      }
    }
  });

  it("the account owns every candidate, and a studio's candidates spread (not one 50-slot pool)", () => {
    const studio = randomUUID();
    const owned = demoOwnedNumbers(studio);
    for (let i = 0; i < DEMO_CANDIDATES; i += 1) {
      const { CA, US } = demoAdoptionInventory(studio, i).numbers;
      expect(owned[CA.phoneNumber]).toBeDefined();
      expect(owned[US.phoneNumber]).toBeDefined();
    }
    // Distinct numbers across a studio's candidates: most of 2 x 16.
    expect(Object.keys(owned).length).toBeGreaterThanOrEqual(24);
    // Area codes vary across candidates (the old pool used one CA and one US code).
    const areas = new Set(Array.from({ length: DEMO_CANDIDATES }, (_, i) => demoAdoptionInventory(studio, i).numbers.CA.phoneNumber.slice(2, 5)));
    expect(areas.size).toBeGreaterThan(4);
  });

  it("deterministic per studio and index; out-of-range indexes clamp", () => {
    const studio = randomUUID();
    expect(demoAdoptionInventory(studio, 3)).toEqual(demoAdoptionInventory(studio, 3));
    expect(demoAdoptionInventory(studio)).toEqual(demoAdoptionInventory(studio, 0));
    expect(demoAdoptionInventory(studio, 999)).toEqual(demoAdoptionInventory(studio, DEMO_CANDIDATES - 1));
  });
});

// Codex P2 4275196090: two studio ids that collide in 32-bit FNV must not
// share a Messaging Service SID (or any number SID).
describe("synthetic SIDs are collision-resistant", () => {
  it("Codex's colliding pair gets DIFFERENT service SIDs", () => {
    const a = demoAdoptionInventory("a9c0bf66-31c4-4b10-b6df-446fe34aa339");
    const b = demoAdoptionInventory("343c02fb-9e91-43a5-8ecf-09ef4a0cce20");
    expect(a.messagingServiceSid).not.toBe(b.messagingServiceSid);
    expect(a.messagingServiceSid).toMatch(/^MG[0-9a-f]{32}$/);
    expect(a.numbers.CA.phoneNumberSid).not.toBe(b.numbers.CA.phoneNumberSid);
  });

  it("no SID repeats across 2,000 studios", () => {
    const sids = new Set<string>();
    for (let k = 0; k < 2000; k += 1) {
      const inv = demoAdoptionInventory(randomUUID());
      for (const sid of [inv.messagingServiceSid, inv.numbers.CA.phoneNumberSid, inv.numbers.US.phoneNumberSid]) {
        expect(sids.has(sid)).toBe(false);
        sids.add(sid);
      }
    }
  });
});
