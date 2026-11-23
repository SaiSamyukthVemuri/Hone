import { describe, expect, it } from "vitest";
import { resolveDeskMembership } from "@/lib/desk/membership";

const a = { id: "r1", studio_id: "s1", display_name: "A" };
const b = { id: "r2", studio_id: "s2", display_name: "B" };
describe("resolveDeskMembership", () => {
  it("none, one, selected and choose", () => {
    expect(resolveDeskMembership([], null)).toEqual({ kind: "none" });
    expect(resolveDeskMembership([], "s1")).toEqual({ kind: "none" });
    expect(resolveDeskMembership([a], null)).toMatchObject({ kind: "one", value: { studioId: "s1" } });
    expect(resolveDeskMembership([a], "s2")).toMatchObject({ kind: "one", value: { studioId: "s1" } });
    expect(resolveDeskMembership([a, b], "s2")).toMatchObject({ kind: "selected", value: { studioId: "s2", receptionistId: "r2" } });
    expect(resolveDeskMembership([a, b], null)).toEqual({ kind: "choose" });
    expect(resolveDeskMembership([a, b], "s9")).toEqual({ kind: "choose" });
  });
});
