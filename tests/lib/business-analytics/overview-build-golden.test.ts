import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { NOW, studio, studioClient, synthetic } from "./helpers-synthetic-studio";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// GOLDEN OUTPUT of the Overview and Clients-tab build (HON-109 slice 2). The build used to spend most of a request re-deriving the same per-visit facts; the
// speed-up must change no number. These digests were recorded from the build BEFORE that change, on a fixed synthetic studio (1,500 appointments, ties on start
// time, every status, two practitioners, straddling now, with recorded cash and e-transfer money) behind a fake that implements the keyset query, so the
// digest of the WHOLE loaded result (every figure, series, table, label and notice) must stay byte-identical. A deliberate change to what the Overview shows
// re-records these digests in the same commit, and says so.
// Re-recorded for HON-122/HON-123: the result gained the kinds `refunded_partial` and `bill_note` and the caveat `refundedPartialCents` (all zero here). The old digests are
// reproduced exactly by removing those three keys, so no figure moved.

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Clients = { sort: "spend"; chip: "all"; page: number };
const load = async (client: SupabaseClient, raw: Record<string, string>, clients?: Clients) => {
  const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
  return loadOverview({ role: "owner" }, studio, "cad", raw, { strict: false, ...(clients ? { clients } : {}) }, NOW, client);
};

const CASES: Array<{ name: string; raw: Record<string, string>; clients?: Clients; sha: string }> = [
  { name: "month to date", raw: {}, sha: "57d3d866b9cd77d7ca80d85f026fb9aedf250f65ba315bf7dc1613da07e52e1a" },
  { name: "previous month", raw: { period: "previous_month" }, sha: "ac3c6871dcc4c31bfdd230ce033d9dbc2cdf019506ea4dc33bab7f467dfb8b4b" },
  { name: "year to date", raw: { period: "year_to_date" }, sha: "b10d7e6bae089c544863afa118905ad248e83381cc39018af8c4226b02470419" },
  { name: "custom range", raw: { period: "custom", from: "2026-06-01", to: "2026-07-31" }, sha: "e148d5ae306eaf51a78ca05b8c770059016e553d21f8fbbf000d291bc10ec7c9" },
  { name: "one practitioner", raw: { practitioner: "pr-2" }, sha: "ef149adaaa8c08564c9791bbf0b82b22c9937f82ae5351119b832b5cde0bddfa" },
  { name: "Clients tab, month to date", raw: {}, clients: { sort: "spend", chip: "all", page: 1 }, sha: "74bf3e2c1a39b85f3513a2f9a10fb1c8505cacdb21e4818dd0c8a801e0522066" },
  { name: "Clients tab, year to date, page 2", raw: { period: "year_to_date" }, clients: { sort: "spend", chip: "all", page: 2 }, sha: "c734a80d75f504ddf9cde86fd57e9818bdc0543ae88532dc4dcecdacbdc15bdc" },
];

describe("the Overview build: golden output on a fixed synthetic studio", () => {
  const data = synthetic(1500);
  for (const c of CASES) {
    it(`${c.name}: the whole result is unchanged`, async () => {
      const r = await load(studioClient(data).client, c.raw, c.clients);
      expect(r).toMatchObject({ access: "granted", ok: true });
      expect(JSON.stringify(r).length).toBeGreaterThan(2000);
      expect(digest(r), c.name).toBe(c.sha);
    }, 60_000);
  }
});
