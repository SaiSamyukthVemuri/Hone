import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake sign-in profile with REPLACE semantics, the worst case: if the action sent only its own key, every other
// key would be lost and these tests would fail.
const state = vi.hoisted(() => ({
  user: null as null | { id: string; user_metadata: unknown },
  updateError: null as null | { message: string },
  throwOn: null as null | "getUser" | "updateUser" | "createClient",
  calls: [] as string[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.throwOn === "createClient") throw new Error("no client");
    return {
      auth: {
        getUser: async () => {
          state.calls.push("getUser");
          if (state.throwOn === "getUser") throw new Error("down");
          return { data: { user: state.user } };
        },
        updateUser: async (attrs: { data?: unknown }) => {
          state.calls.push("updateUser");
          if (state.throwOn === "updateUser") throw new Error("down");
          if (state.updateError) return { error: state.updateError };
          state.user!.user_metadata = attrs.data; // replace
          return { error: null };
        },
      },
      from: () => {
        state.calls.push("from");
        throw new Error("the preference must not touch any table");
      },
    };
  },
}));

import { setChartingViewAction } from "@/app/(app)/charting-view-actions";
import { NOT_REMEMBERED_MESSAGE } from "@/lib/charting/view-preference";

beforeEach(() => {
  state.user = { id: "u1", user_metadata: { full_name: "Avery Example", theme: { dark: true } } };
  state.updateError = null;
  state.throwOn = null;
  state.calls = [];
});

describe("setChartingViewAction", () => {
  it("writes only the one key and keeps the rest of the profile (merge, never replace)", async () => {
    expect(await setChartingViewAction("new")).toEqual({ ok: true });
    expect(state.user!.user_metadata).toEqual({ full_name: "Avery Example", theme: { dark: true }, charting_view: "new" });
    expect(await setChartingViewAction("current")).toEqual({ ok: true });
    expect(state.user!.user_metadata).toEqual({
      full_name: "Avery Example",
      theme: { dark: true },
      charting_view: "current",
    });
  });
  it("works when the profile has no metadata yet", async () => {
    state.user = { id: "u1", user_metadata: undefined };
    expect(await setChartingViewAction("new")).toEqual({ ok: true });
    expect(state.user.user_metadata).toEqual({ charting_view: "new" });
  });
  it("touches nothing but the sign-in profile: one read, one write, no table", async () => {
    await setChartingViewAction("new");
    expect(state.calls).toEqual(["getUser", "updateUser"]);
  });
  it.each([undefined, null, "", "New", "all", 1, {}, ["new"], "new "])("refuses %j without writing", async (v) => {
    expect(await setChartingViewAction(v)).toEqual({ ok: false, error: NOT_REMEMBERED_MESSAGE });
    expect(state.calls).toEqual([]);
  });
  it("a failure is reported as not remembered, never thrown", async () => {
    state.updateError = { message: "rejected" };
    expect(await setChartingViewAction("new")).toEqual({ ok: false, error: NOT_REMEMBERED_MESSAGE });
    state.updateError = null;
    for (const t of ["getUser", "updateUser", "createClient"] as const) {
      state.throwOn = t;
      expect(await setChartingViewAction("new")).toEqual({ ok: false, error: NOT_REMEMBERED_MESSAGE });
    }
    state.throwOn = null;
    state.user = null;
    expect(await setChartingViewAction("new")).toEqual({ ok: false, error: NOT_REMEMBERED_MESSAGE });
  });
  it("the message says the choice was not remembered and that charting still works", () => {
    expect(NOT_REMEMBERED_MESSAGE).toMatch(/wasn't remembered/);
    expect(NOT_REMEMBERED_MESSAGE).toMatch(/Charting still works/);
  });
});
