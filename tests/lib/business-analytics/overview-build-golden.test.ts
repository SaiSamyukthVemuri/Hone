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

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Clients = { sort: "spend"; chip: "all"; page: number };
const load = async (client: SupabaseClient, raw: Record<string, string>, clients?: Clients) => {
  const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
  return loadOverview({ role: "owner" }, studio, "cad", raw, { strict: false, ...(clients ? { clients } : {}) }, NOW, client);
};

const CASES: Array<{ name: string; raw: Record<string, string>; clients?: Clients; sha: string }> = [
  { name: "month to date", raw: {}, sha: "35cecce2cd84143db3cee7022e54dd48afd756157e1f45236915f60b80762219" },
  // RE-RECORDED (Codex P2, 26 Nov 2026): the ONLY change is params.compare, which is now "previous_month" for Last month (its comparison is the calendar month
  // before it, by definition) where it was "preceding". Replacing that one value back reproduces the old digest 429d5e10... exactly, so no figure moved.
  { name: "previous month", raw: { period: "previous_month" }, sha: "91128944ca1fd235c05e6fdd3742882431843b88ad2ad9c0329137a512133a2c" },
  { name: "year to date", raw: { period: "year_to_date" }, sha: "f64dac57c4c8cc4f9ee59957a950148eb89f110902a216f801991cbfd927802d" },
  { name: "custom range", raw: { period: "custom", from: "2026-06-01", to: "2026-07-31" }, sha: "c5e24b56fe6712ec5da2cd67bee48718bedb44771ea2392a007f2b1d09f767b2" },
  { name: "one practitioner", raw: { practitioner: "pr-2" }, sha: "40af2a208e790b6cf4a4015e3d9f30d1630b6d833f862bb346cdc249b059ba2c" },
  { name: "Clients tab, month to date", raw: {}, clients: { sort: "spend", chip: "all", page: 1 }, sha: "0ecbb88c3921758501fbef9c2c65db3f5d9f0dcc8cc478454e1217f9b6bfee37" },
  { name: "Clients tab, year to date, page 2", raw: { period: "year_to_date" }, clients: { sort: "spend", chip: "all", page: 2 }, sha: "9ec45246ef1ae415ee9470e213d16201b858892b4024a7de30b30186398c7bd9" },
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
