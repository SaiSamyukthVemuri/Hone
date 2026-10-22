import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_CANDIDATES, demoAdoptionInventory, demoOwnedNumbers, demoOwnedServices } from "@/lib/sms/sender-controls-demo";
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
    // Every number distinct within the studio (Codex P2 4276086876): 2 x 16.
    expect(Object.keys(owned).length).toBe(2 * DEMO_CANDIDATES);
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

  // 300 studios: broad enough, and quick enough to stay inside a loaded CI run.
  it("no SID repeats across 300 studios", { timeout: 30_000 }, () => {
    const sids = new Set<string>();
    for (let k = 0; k < 300; k += 1) {
      const inv = demoAdoptionInventory(randomUUID());
      for (const sid of [inv.messagingServiceSid, inv.numbers.CA.phoneNumberSid, inv.numbers.US.phoneNumberSid]) {
        expect(sids.has(sid)).toBe(false);
        sids.add(sid);
      }
    }
  });
});

// Codex P2 4275860500: one service per candidate, so a released adoption's
// service never blocks the studio's next demo.
describe("a Messaging Service per candidate", () => {
  it("every candidate has its own service SID, holding exactly that candidate's two numbers", () => {
    const studio = randomUUID();
    const services = demoOwnedServices(studio);
    expect(services).toHaveLength(DEMO_CANDIDATES);
    expect(new Set(services.map((x) => x.sid)).size).toBe(DEMO_CANDIDATES);
    services.forEach((svc, i) => {
      const inv = demoAdoptionInventory(studio, i);
      expect(svc.sid).toBe(inv.messagingServiceSid);
      expect(svc.numbers).toEqual([inv.numbers.CA.phoneNumber, inv.numbers.US.phoneNumber]);
    });
  });
});

// Codex P2 4276086876: a number must belong to exactly ONE candidate (and so
// one service) within a studio, or the fake account calls it ambiguous.
describe("no number repeats within a studio", () => {
  it("Codex's studio: CA candidates 0 and 4 no longer share a number", () => {
    const studio = "00000000-0000-0000-0000-000000000838";
    const ca = Array.from({ length: DEMO_CANDIDATES }, (_, i) => demoAdoptionInventory(studio, i).numbers.CA.phoneNumber);
    expect(new Set(ca).size).toBe(DEMO_CANDIDATES);
  });

  it("across 300 studios, every number is in exactly one of the studio's services", { timeout: 30_000 }, () => {
    for (let k = 0; k < 300; k += 1) {
      const studio = randomUUID();
      const seen = new Map<string, number>();
      for (const svc of demoOwnedServices(studio)) for (const n of svc.numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
      expect(seen.size, studio).toBe(2 * DEMO_CANDIDATES);
      for (const [n, c] of seen) expect(c, `${studio} ${n}`).toBe(1);
    }
  });

  it("the fake account reports a single association for candidate 0 of Codex's studio", async () => {
    const { senderControlsFakeProvider } = await import("@/lib/sms/sender-controls");
    const studio = "00000000-0000-0000-0000-000000000838";
    const inv = demoAdoptionInventory(studio, 0);
    const fake = senderControlsFakeProvider("https://hone.example", studio, { NEXT_PUBLIC_APP_ORIGIN: "https://hone.example" });
    const r = await fake.lookupOwnedNumber({ phoneNumber: inv.numbers.CA.phoneNumber, expectedMessagingServiceSid: inv.messagingServiceSid });
    expect(r.ok).toBe(true);
    expect(r.ok && r.facts.association.kind).not.toBe("ambiguous");
  });
});
