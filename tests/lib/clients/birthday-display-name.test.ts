import { describe, expect, it, vi } from "vitest";

// Privacy C2 / Insurance N2: the birthday list shows, and SORTS by, the display
// identity. Synthetic names only.
const rows = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
  noPreferred: false,
  orderCalls: [] as string[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      let cols = "";
      const q: Record<string, unknown> = {};
      q.select = (c: string) => ((cols = c), q);
      for (const m of ["eq", "is", "not"]) q[m] = () => q;
      q.order = (c: string) => (rows.orderCalls.push(c), q);
      q.then = (resolve: (v: unknown) => unknown) => {
        if (rows.noPreferred && cols.includes("preferred_name"))
          return resolve({ data: null, error: { code: "42703", message: 'column "preferred_name" does not exist' } });
        return resolve({
          data: rows.data.map((r) => (cols.includes("preferred_name") ? r : { ...r, preferred_name: undefined })),
          error: null,
        });
      };
      return q;
    },
  }),
}));

import { getClientBirthdaysForMonth } from "@/lib/clients/birthday-queries";

const dob = (d: number) => `2000-11-${String(d).padStart(2, "0")}`;

describe("getClientBirthdaysForMonth display identity", () => {
  it("shows the preferred name, never the stored one", async () => {
    rows.noPreferred = false;
    rows.data = [{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha", date_of_birth: dob(3) }];
    const out = await getClientBirthdaysForMonth("s", 11);
    expect(out.map((r) => r.name)).toEqual(["Preferred Alpha"]);
    expect(JSON.stringify(out)).not.toContain("Stored Alpha");
  });

  it("sorts same-day birthdays by DISPLAY name, not the stored name (no order leak), ties by id", async () => {
    rows.noPreferred = false;
    rows.data = [
      // stored order would be Alpha, Beta; display order is Aardvark... reversed
      { id: "1", name: "Stored Alpha", preferred_name: "Zed", date_of_birth: dob(5) },
      { id: "2", name: "Stored Beta", preferred_name: "Amy", date_of_birth: dob(5) },
      { id: "4", name: "Same", preferred_name: null, date_of_birth: dob(5) },
      { id: "3", name: "Same", preferred_name: null, date_of_birth: dob(5) },
      { id: "5", name: "Early", preferred_name: null, date_of_birth: dob(2) },
    ];
    const out = await getClientBirthdaysForMonth("s", 11);
    expect(out.map((r) => r.id)).toEqual(["5", "2", "3", "4", "1"]);
    // The query itself no longer orders by the stored name.
    expect(rows.orderCalls).not.toContain("name");
  });

  it("falls back to the stored name on a database without the preferred_name column", async () => {
    rows.noPreferred = true;
    rows.data = [{ id: "a", name: "Stored Alpha", preferred_name: "Preferred Alpha", date_of_birth: dob(3) }];
    expect((await getClientBirthdaysForMonth("s", 11)).map((r) => r.name)).toEqual(["Stored Alpha"]);
  });

  it("only month and day leave the function", async () => {
    rows.noPreferred = false;
    rows.data = [{ id: "a", name: "A", preferred_name: null, date_of_birth: "1987-11-03" }];
    const out = await getClientBirthdaysForMonth("s", 11);
    expect(Object.keys(out[0]).sort()).toEqual(["day", "id", "month", "name"]);
    expect(JSON.stringify(out)).not.toContain("1987");
  });
});
