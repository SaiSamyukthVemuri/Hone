// SMS-SENDER-CONTROL-01 (#824): the FAKE provider account the studio number
// controls demonstrate. Pure data, safe for the client panel to show: synthetic
// 555-01xx numbers and synthetic SIDs. Nothing here is a real account.
//
// PER STUDIO (Codex P2 4251747847). One shared demo service across studios
// meant the second studio to adopt passed every check and then hit 0191's
// uniqueness on the finalize, parked behind a write-once claim. Each studio
// now gets its own pair of numbers and its own Messaging Service, derived
// from its id, from the line range 555-0150..0199, which the fake's search
// (555-0100..0149) never offers for purchase. Two studios can still collide
// on a number (50 slots per country); the pre-claim recorded-resource check
// (0226 studio_sms_resource_recorded) refuses that BEFORE any claim.

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

export function demoAdoptionInventory(studioId: string): DemoAdoptionInventory {
  const line = String(150 + (fnv1a(studioId) % 50)).padStart(4, "0");
  return {
    messagingServiceSid: `MG${hex32(`mg:${studioId}`)}`,
    numbers: {
      CA: { phoneNumber: `+1416555${line}`, phoneNumberSid: `PN${hex32(`ca:${studioId}`)}` },
      US: { phoneNumber: `+1212555${line}`, phoneNumberSid: `PN${hex32(`us:${studioId}`)}` },
    },
  };
}
