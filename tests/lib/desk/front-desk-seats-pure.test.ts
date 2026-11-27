import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client"); } }));

import { parseFrontDeskSummary } from "@/lib/team-seats/summary";
import { receptionistsOverLimit } from "@/lib/team-seats/rank";
import { seatRefusalMessage, FRONT_DESK_FULL_MESSAGE, FRONT_DESK_OFF_MESSAGE } from "@/lib/team-seats/errors";
import { parseFrontDeskListing } from "@/lib/rollouts/front-desk-admin";

describe("the owner summary parser fails closed", () => {
  const ok = { status: "ok", switch_on: true, seat_limit: 2, seats_active: 1, seats_reserved: 1, seats_available: 0, seats_over_limit: 0 };
  it("reads a good answer", () => expect(parseFrontDeskSummary(ok)).toEqual({ switchOn: true, seatLimit: 2, seatsActive: 1, seatsReserved: 1, seatsAvailable: 0, seatsOverLimit: 0 }));
  it("anything else is null: not_authorized, a missing field, a negative or fractional number, a wrong type", () => {
    for (const bad of [null, "ok", { status: "not_authorized" }, { ...ok, switch_on: "true" }, { ...ok, seat_limit: -1 }, { ...ok, seats_active: 1.5 }, { ...ok, seats_available: undefined }]) {
      expect(parseFrontDeskSummary(bad)).toBeNull();
    }
  });
  it("never carries a reason, even if the database were to send one", () => {
    expect(JSON.stringify(parseFrontDeskSummary({ ...ok, reason: "secret", seats: [{ reason: "secret" }] }))).not.toContain("secret");
  });
});

describe("who the gate refuses when a studio is over its limit", () => {
  const r = (id: string, created_at: string, active = true) => ({ id, active, created_at });
  it("the newest active receptionists beyond the limit; the oldest keep their seat", () => {
    const rows = [r("c", "2026-03-01"), r("a", "2026-01-01"), r("b", "2026-02-01"), r("z", "2026-04-01", false)];
    expect([...receptionistsOverLimit(rows, 1)].sort()).toEqual(["b", "c"]);
    expect([...receptionistsOverLimit(rows, 2)]).toEqual(["c"]);
    expect(receptionistsOverLimit(rows, 3).size).toBe(0);
    expect([...receptionistsOverLimit(rows, 0)].sort()).toEqual(["a", "b", "c"]);
  });
  it("ties on created_at fall to id, the same as the database's rank", () => {
    expect([...receptionistsOverLimit([r("b", "2026-01-01"), r("a", "2026-01-01")], 1)]).toEqual(["b"]);
  });
});

describe("raised database refusals map to plain words", () => {
  it("seat limit and not enabled, and nothing else", () => {
    expect(seatRefusalMessage({ message: "front_desk_seat_limit_reached" })).toBe(FRONT_DESK_FULL_MESSAGE);
    expect(seatRefusalMessage({ message: "ERROR: front_desk_not_enabled" })).toBe(FRONT_DESK_OFF_MESSAGE);
    expect(seatRefusalMessage({ message: "something else" })).toBeNull();
    expect(seatRefusalMessage(null)).toBeNull();
  });
});

describe("the admin listing parser", () => {
  const base = { switch_on: true, seat_limit: 1, seats_active: 0, seats_reserved: 0, seats_over_limit: 0, seats: [{ id: "i", seats: 1, source: "pilot", reason: "r", granted_at: "2026-11-26T00:00:00Z", expires_at: null, state: "live" }] };
  it("reads a good listing and rejects a malformed one", () => {
    expect(parseFrontDeskListing(base)?.seats[0]).toMatchObject({ id: "i", state: "live", expiresAt: null });
    expect(parseFrontDeskListing({ ...base, seats: [{ ...base.seats[0], state: "weird" }] })).toBeNull();
    expect(parseFrontDeskListing({ ...base, seats: "nope" })).toBeNull();
    expect(parseFrontDeskListing(null)).toBeNull();
  });
});

import { hasRecentIdenticalGrant, safeNotice } from "@/lib/rollouts/front-desk-admin";
import { seatsNoticeMessage } from "@/lib/team-seats/errors";

describe("safeNotice: only the fixed outcome sentences reach the admin page", () => {
  it("renders a known sentence and the counted over-limit sentence", () => {
    expect(safeNotice("Seats granted.", true)).toBe("Seats granted.");
    const counted = "Revoked. 2 receptionists are now over the seat limit and cannot use the front desk. Nothing was deleted.";
    expect(safeNotice(counted, true)).toBe(counted);
  });
  it("replaces anything else with a generic line and shows nothing for no notice", () => {
    expect(safeNotice("Call 555-0100 for Jane", true)).toBe("Done.");
    expect(safeNotice("<b>x</b>", false)).toBe("That did not go through.");
    expect(safeNotice("Revoked. 9999 receptionists are now over the seat limit and cannot use the front desk. Nothing was deleted.", true)).toBe("Done.");
    expect(safeNotice(undefined, true)).toBeNull();
    expect(safeNotice("", false)).toBeNull();
  });
});

describe("the Team page's seats notice accepts only its two codes", () => {
  it("maps off and full to the fixed sentences and anything else to nothing", () => {
    expect(seatsNoticeMessage("off")).toBe(FRONT_DESK_OFF_MESSAGE);
    expect(seatsNoticeMessage("full")).toBe(FRONT_DESK_FULL_MESSAGE);
    expect(seatsNoticeMessage("<script>")).toBeNull();
    expect(seatsNoticeMessage(undefined)).toBeNull();
  });
});

describe("a grant that arrives twice is recognised", () => {
  const now = Date.parse("2026-11-27T12:00:30Z");
  const listing = (grantedAt: string, state: "live" | "revoked" = "live") => ({
    switchOn: true, seatLimit: 1, seatsActive: 0, seatsReserved: 0, seatsOverLimit: 0,
    seats: [{ id: "s1", seats: 1, source: "pilot", reason: "pilot seat", grantedAt, expiresAt: null, state }],
  });
  const ask = { seats: 1, source: "pilot", reason: "pilot seat", expiresAt: null };
  it("is a duplicate only when seats, source, reason and expiry match and it was granted within the window", () => {
    expect(hasRecentIdenticalGrant(listing("2026-11-27T12:00:00Z"), ask, now)).toBe(true);
    expect(hasRecentIdenticalGrant(listing("2026-11-27T11:58:00Z"), ask, now)).toBe(false); // an old identical grant is a deliberate second one
    expect(hasRecentIdenticalGrant(listing("2026-11-27T12:00:00Z", "revoked"), ask, now)).toBe(false);
    expect(hasRecentIdenticalGrant(listing("2026-11-27T12:00:00Z"), { ...ask, seats: 2 }, now)).toBe(false);
    expect(hasRecentIdenticalGrant(listing("2026-11-27T12:00:00Z"), { ...ask, reason: "other" }, now)).toBe(false);
    expect(hasRecentIdenticalGrant(null, ask, now)).toBe(false);
  });
});
