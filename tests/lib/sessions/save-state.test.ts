import { describe, expect, it } from "vitest";
import {
  INITIAL_SAVE_STATE,
  isUnfinished,
  saveStateReducer as r,
  type SaveState,
} from "@/lib/sessions/save-state";

const S = (status: SaveState["status"]): SaveState =>
  status === "failed" ? { status, message: "x" } : ({ status } as SaveState);

describe("save state", () => {
  it("saved is reachable only from saving", () => {
    for (const from of ["unsaved", "saved", "failed"] as const) {
      expect(r(S(from), { type: "saveSucceeded" })).toEqual(S(from));
    }
    expect(r(S("saving"), { type: "saveSucceeded" })).toEqual({ status: "saved" });
  });
  it("an edit after saved, saving or failed is unsaved", () => {
    for (const from of ["saved", "saving", "failed"] as const) {
      expect(r(S(from), { type: "edit" })).toEqual({ status: "unsaved" });
    }
  });
  it("a failure keeps its message and only a retry leaves it", () => {
    const failed = r(S("saving"), { type: "saveFailed", message: "offline" });
    expect(failed).toEqual({ status: "failed", message: "offline" });
    expect(r(failed, { type: "saveSucceeded" })).toEqual(failed);
    expect(r(failed, { type: "saveStarted" })).toEqual({ status: "saving" });
  });
  it("a failure report with no save in flight is ignored", () => {
    expect(r(S("unsaved"), { type: "saveFailed", message: "x" })).toEqual(S("unsaved"));
  });
  it("reset returns the initial state; only saved is not unfinished", () => {
    expect(r(S("failed"), { type: "reset" })).toEqual(INITIAL_SAVE_STATE);
    expect(["unsaved", "saving", "failed"].every((s) => isUnfinished(S(s as SaveState["status"])))).toBe(true);
    expect(isUnfinished(S("saved"))).toBe(false);
  });
});
