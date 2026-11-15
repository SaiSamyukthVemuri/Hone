import { describe, expect, it, vi } from "vitest";

// Insurance K1: an ordinary search, name sort or page click must not scan every
// appointment and intake form of the studio. The whole-studio aggregates are read
// only when they decide the set or its order.

type Call = { table: string; scoped: boolean };
const calls: Call[] = [];

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    studio: { id: "studio-1", timezone: "UTC" },
    practitioner: { id: "p1", role: "owner" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const call: Call = { table, scoped: false };
      calls.push(call);
      let afterId = false;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "is", "not", "lte", "gte", "lt", "order"]) q[m] = () => q;
      q.in = (col: string) => { if (col === "client_id") call.scoped = true; return q; };
      q.gt = () => { afterId = true; return q; };
      q.range = async () => ({
        data: table === "clients" && !afterId
          ? [{ id: "c1", name: "Visible Name", pronouns: null, email: null, phone: null, archived_at: null }]
          : [],
        error: null,
      });
      return q;
    },
  }),
}));
vi.mock("@/components/pending-link", () => ({ PendingLink: () => null }));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/(app)/clients/[id]/actions", () => ({ unarchiveClientAction: async () => {} }));

import ClientsPage from "@/app/(app)/clients/page";

async function reads(sp: Record<string, string | string[]>) {
  calls.length = 0;
  await ClientsPage({ searchParams: Promise.resolve(sp) });
  const of = (t: string) => calls.filter((c) => c.table === t);
  return {
    appointments: of("appointments").filter((c) => !c.scoped).length,
    intake: of("client_intake_forms").filter((c) => !c.scoped).length,
    scopedIntake: of("client_intake_forms").filter((c) => c.scoped).length,
  };
}

describe("per-interaction reads are bounded (K1)", () => {
  it("default, search and page requests read appointments (next) and intake only for the page's clients", async () => {
    const requests: Array<Record<string, string>> = [{}, { q: "visible" }, { page: "1" }, { sort: "name" }];
    for (const sp of requests) {
      const r = await reads(sp);
      expect(r.intake).toBe(0);
      expect(r.scopedIntake).toBe(1);
      expect(r.appointments).toBe(0);
    }
  });

  it("whole-studio aggregates are read only when they decide the set or the order", async () => {
    expect(await reads({ sort: "next" })).toMatchObject({ appointments: 1, intake: 0 });
    expect(await reads({ filter: "no_upcoming" })).toMatchObject({ appointments: 1, intake: 0 });
    expect(await reads({ filter: "intake_review" })).toMatchObject({ appointments: 0, intake: 1 });
  });

  it("the archived view reads neither, even with filters typed into the URL", async () => {
    const r = await reads({ view: "archived", filter: ["no_upcoming", "intake_review"] });
    expect(r).toEqual({ appointments: 0, intake: 0, scopedIntake: 0 });
  });
});
