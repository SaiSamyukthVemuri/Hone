import { beforeEach, describe, expect, it, vi } from "vitest";

// #1172 two-studio addendum: updateDisinfectantRecordAction filters on the record
// id AND the caller's studio. When another studio's id is supplied, RLS plus that
// filter match ZERO rows; the action used to report { ok: true } ("Record saved.")
// for that no-op. A save that changed nothing must say so, without naming
// anything about the other studio's row. Synthetic ids only.

const state = vi.hoisted(() => ({
  matched: [] as Array<{ id: string }>,
  error: null as unknown,
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { display_name: "Member A", email: "a@example.test" },
    studio: { id: "studio-a" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      state.calls.push(["from", table]);
      const builder: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: state.matched, error: state.error }).then(resolve);
            }
            return (...args: unknown[]) => {
              state.calls.push([prop, ...args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  }),
}));

import { updateDisinfectantRecordAction } from "@/app/(app)/records/actions";

function form(recordId: string): FormData {
  const fd = new FormData();
  fd.set("record_id", recordId);
  fd.set("date_prepared", "2026-10-01");
  fd.set("disinfectant_name", "Synthetic jar");
  fd.set("date_discarded", "2026-10-20");
  return fd;
}

beforeEach(() => {
  state.matched = [];
  state.error = null;
  state.calls = [];
});

describe("updateDisinfectantRecordAction: a save that matched nothing", () => {
  it("reports failure when no row matched (another studio's id, or an unknown id)", async () => {
    const res = await updateDisinfectantRecordAction(form("record-of-another-studio"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain("record-of-another-studio");
  });
  it("filters the update on the caller's studio as well as the id", async () => {
    await updateDisinfectantRecordAction(form("rec-1"));
    expect(state.calls).toContainEqual(["eq", "id", "rec-1"]);
    expect(state.calls).toContainEqual(["eq", "studio_id", "studio-a"]);
  });
  it("still reports success when the row matched (control)", async () => {
    state.matched = [{ id: "rec-1" }];
    const res = await updateDisinfectantRecordAction(form("rec-1"));
    expect(res).toEqual({ ok: true });
  });
});
