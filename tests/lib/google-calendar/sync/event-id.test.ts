import { describe, expect, it } from "vitest";
import {
  buildEventMarker,
  deriveEventId,
  deriveLinkFingerprint,
  EVENT_ID_DIGEST_LENGTH,
  EVENT_ID_TOTAL_LENGTH,
  verifyEventMarker,
} from "@/lib/google-calendar/sync/event-id";

// Phase B2.3-c1 — deterministic provider identity + private correlation marker.

const STUDIO = "9d37c51a-0000-0000-0000-000000000001";
const LINK_A = "11111111-2222-3333-4444-555555555555";
const LINK_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ID_RE = /^hone1[0-9a-v]{52}$/;

describe("deriveEventId", () => {
  it("is exactly 57 chars: hone1 + a full 52-char base32hex digest, [0-9a-v] only", () => {
    const id = deriveEventId(STUDIO, LINK_A);
    expect(id.length).toBe(EVENT_ID_TOTAL_LENGTH);
    expect(id.slice(0, 5)).toBe("hone1");
    expect(id.slice(5).length).toBe(EVENT_ID_DIGEST_LENGTH);
    expect(id).toMatch(ID_RE);
    expect(id).toBe(id.toLowerCase());
  });

  it("is stable across repeated derivation (retries/replays/restarts)", () => {
    expect(deriveEventId(STUDIO, LINK_A)).toBe(deriveEventId(STUDIO, LINK_A));
  });

  it("changes ONLY when the link id changes (a new provider lifecycle)", () => {
    expect(deriveEventId(STUDIO, LINK_A)).not.toBe(deriveEventId(STUDIO, LINK_B));
    // A different studio also separates the id space (per-calendar uniqueness).
    expect(deriveEventId(STUDIO, LINK_A)).not.toBe(deriveEventId("other-studio", LINK_A));
  });

  it("does not depend on any mutable appointment value (only studio + link id)", () => {
    // The function signature makes this structural — there is no version/time input.
    expect(deriveEventId.length).toBe(2);
  });
});

describe("marker", () => {
  it("builds hone='1' + a non-reversible hlk fingerprint of the link id", () => {
    const m = buildEventMarker(LINK_A);
    expect(m.hone).toBe("1");
    expect(m.hlk).toBe(deriveLinkFingerprint(LINK_A));
    expect(m.hlk).toMatch(/^[0-9a-v]{52}$/);
    // Never the raw UUID.
    expect(m.hlk).not.toContain(LINK_A);
    expect(JSON.stringify(m)).not.toContain(LINK_A);
  });

  it("verifies match / mismatch / absent", () => {
    const priv = buildEventMarker(LINK_A);
    expect(verifyEventMarker(priv, LINK_A)).toBe("match");
    expect(verifyEventMarker(priv, LINK_B)).toBe("mismatch");
    expect(verifyEventMarker(null, LINK_A)).toBe("absent");
    expect(verifyEventMarker({ hone: "1" }, LINK_A)).toBe("absent");
    expect(verifyEventMarker({ hlk: priv.hlk }, LINK_A)).toBe("absent");
  });
});
