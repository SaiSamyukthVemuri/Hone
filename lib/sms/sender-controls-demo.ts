// SMS-SENDER-CONTROL-01 (#824): the FAKE provider account the studio number
// controls demonstrate. Pure data, safe for the client panel to show: synthetic
// 555-01xx numbers and synthetic SIDs. Nothing here is a real account.
//
// PER STUDIO (Codex P2 4251747847). One shared demo service across studios
// meant the second studio to adopt passed every check and then hit 0191's
// uniqueness on the finalize, parked behind a write-once claim. Each studio
// gets its own Messaging Service, derived from its id.
//
// AND NUMBERS NO OTHER STUDIO HOLDS (Codex P2 4274756044). Hashing every studio
// into one 50-slot line range meant two studios could share BOTH numbers, and
// once either adopted, the other's demo could never succeed. Now each studio
// has DEMO_CANDIDATES deterministic candidate pairs, spread over 20 Canadian
// and 20 US area codes and the line range 555-0150..0199 (which the fake's
// search, 555-0100..0149, never offers for purchase). The studio's fake
// account owns ALL of them, and the page advertises the first pair that no
// other studio records (resolveDemoInventory in sender-controls.ts, through
// 0226's studio_sms_resource_recorded), so a collision moves this studio to
// its next candidate instead of wedging its demo.

/** FNV-1a, 32-bit: a small deterministic spread, not a security property. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hex32(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 32; i += 1) out += fnv1a(`${seed}:${i}`).toString(16).padStart(8, "0");
  return out.slice(0, 32);
}

export type DemoAdoptionInventory = {
  messagingServiceSid: string;
  numbers: {
    CA: { phoneNumber: string; phoneNumberSid: string };
    US: { phoneNumber: string; phoneNumberSid: string };
  };
};

/** How many candidate pairs a studio's fake account owns. */
export const DEMO_CANDIDATES = 16;

const DEMO_CA_AREAS = ["416", "647", "437", "905", "289", "365", "613", "343", "514", "438", "604", "778", "403", "587", "780", "825", "204", "431", "306", "639"] as const;
const DEMO_US_AREAS = ["212", "646", "332", "718", "347", "917", "929", "310", "213", "323", "312", "773", "415", "628", "206", "617", "202", "305", "713", "512"] as const;

function demoNumber(areas: readonly string[], seed: string): string {
  const h = fnv1a(seed);
  const line = String(150 + ((h >>> 8) % 50)).padStart(4, "0");
  return `+1${areas[h % areas.length]}555${line}`;
}

/**
 * The studio's candidate `index` (0 .. DEMO_CANDIDATES-1). Candidate 0 is the
 * default; resolveDemoInventory picks the first one no other studio records.
 */
export function demoAdoptionInventory(studioId: string, index = 0): DemoAdoptionInventory {
  const i = Math.max(0, Math.min(DEMO_CANDIDATES - 1, Math.trunc(index)));
  return {
    messagingServiceSid: `MG${hex32(`mg:${studioId}`)}`,
    numbers: {
      CA: { phoneNumber: demoNumber(DEMO_CA_AREAS, `ca#${i}:${studioId}`), phoneNumberSid: `PN${hex32(`ca#${i}:${studioId}`)}` },
      US: { phoneNumber: demoNumber(DEMO_US_AREAS, `us#${i}:${studioId}`), phoneNumberSid: `PN${hex32(`us#${i}:${studioId}`)}` },
    },
  };
}

/** Every number the studio's fake account owns, with its SID. */
export function demoOwnedNumbers(studioId: string): Record<string, string> {
  const owned: Record<string, string> = {};
  for (let i = 0; i < DEMO_CANDIDATES; i += 1) {
    const { CA, US } = demoAdoptionInventory(studioId, i).numbers;
    owned[CA.phoneNumber] ??= CA.phoneNumberSid;
    owned[US.phoneNumber] ??= US.phoneNumberSid;
  }
  return owned;
}
