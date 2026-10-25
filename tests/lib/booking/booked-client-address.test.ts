// HON-50 (Sam, 24 Oct, decision C). The booking-success screen may show an
// address the owner keeps off the public page only after the SERVER verified
// the booking's own token, its studio and its confirmed status. Every other
// viewer gets null. All values are synthetic.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bookedClientAddressForToken } from "@/lib/booking/booked-client-address";

const ADDRESS = "100 Synthetic Private Lane, Toronto ON";
const TOKEN = "SyntheticRawAppointmentToken_0123456789";
const APPT_ID = "00000000-0000-4000-8000-0000000000b1";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Row = {
  status: string;
  hash: string;
  studio: { slug: string; address: string | null; address_visibility?: string } | null;
};

function admin(rows: Row[], opts: { error?: boolean; throws?: boolean } = {}) {
  const filters: Array<[string, unknown]> = [];
  const client = {
    filters,
    from: (table: string) => {
      expect(table).toBe("appointments");
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        maybeSingle: async () => {
          if (opts.throws) throw new Error("synthetic transport failure");
          if (opts.error) return { data: null, error: { code: "XX000", message: "synthetic" } };
          const [col, val] = filters[filters.length - 1] ?? [];
          const hit = col === "cancellation_token_hash" ? rows.find((r) => r.hash === val) : undefined;
          return { data: hit ? { id: APPT_ID, status: hit.status, studio: hit.studio } : null, error: null };
        },
      };
      return q;
    },
  };
  return client;
}

const privateStudio = { slug: "synthetic", address: ADDRESS, address_visibility: "emails" };
const booked: Row = { status: "confirmed", hash: sha(TOKEN), studio: privateStudio };
const reveal = (a: ReturnType<typeof admin>, slug = "synthetic", token = TOKEN) =>
  bookedClientAddressForToken(a as never, { slug, token });

describe("authorized: the booking's own token, this studio, confirmed", () => {
  it("reveals the booked-client address", async () => {
    expect(await reveal(admin([booked]))).toBe(ADDRESS);
  });

  it("looks the booking up ONLY by the SHA-256 of the presented token, never by id", async () => {
    const a = admin([booked]);
    await reveal(a);
    expect(a.filters).toEqual([["cancellation_token_hash", sha(TOKEN)]]);
  });

  it("a row from before the visibility column (absent = both) still answers the address", async () => {
    expect(
      await reveal(admin([{ ...booked, studio: { slug: "synthetic", address: ADDRESS } }])),
    ).toBe(ADDRESS);
  });
});

describe("every other viewer gets nothing", () => {
  it("unauthorized: an unknown token", async () => {
    expect(await reveal(admin([booked]), "synthetic", "SomeoneElsesGuessedToken_000000000")).toBeNull();
  });

  it("unauthorized: the bare appointment id presented as a token", async () => {
    expect(await reveal(admin([booked]), "synthetic", APPT_ID)).toBeNull();
  });

  it.each(["", "   ", "short"])("unauthorized: an empty or short token %j (no query at all)", async (t) => {
    const a = admin([booked]);
    expect(await reveal(a, "synthetic", t)).toBeNull();
    expect(a.filters).toEqual([]);
  });

  it("wrong studio: a valid token for a booking at another studio, on this studio's page", async () => {
    const other: Row = { status: "confirmed", hash: sha(TOKEN), studio: { slug: "other-studio", address: "9 Other Rd", address_visibility: "emails" } };
    expect(await reveal(admin([other]), "synthetic")).toBeNull();
  });

  it.each(["pending", "pending_payment", "cancelled", "no_show", "completed", "rescheduled"])(
    "status %s is not confirmed",
    async (status) => {
      expect(await reveal(admin([{ ...booked, status }]))).toBeNull();
    },
  );

  it("an embed with no studio", async () => {
    expect(await reveal(admin([{ ...booked, studio: null }]))).toBeNull();
  });

  it("'booking_page' visibility: nothing extra to reveal (the public page already decides)", async () => {
    expect(
      await reveal(admin([{ ...booked, studio: { ...privateStudio, address_visibility: "booking_page" } }])),
    ).toBeNull();
  });

  it("a blank address", async () => {
    expect(await reveal(admin([{ ...booked, studio: { ...privateStudio, address: "   " } }]))).toBeNull();
  });

  it("a read error answers null", async () => {
    expect(await reveal(admin([booked], { error: true }))).toBeNull();
  });

  it("a thrown read answers null, never throws", async () => {
    await expect(reveal(admin([booked], { throws: true }))).resolves.toBeNull();
  });
});
