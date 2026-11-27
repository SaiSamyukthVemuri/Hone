import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client"); } }));

import { parseFrontDeskSummary } from "@/lib/desk/seats";
import { receptionistsOverLimit } from "@/lib/desk/seat-rank";
import { seatRefusalMessage, FRONT_DESK_FULL_MESSAGE, FRONT_DESK_OFF_MESSAGE } from "@/lib/desk/seat-errors";
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
