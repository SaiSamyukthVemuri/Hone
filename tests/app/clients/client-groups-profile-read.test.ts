import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn(), catalogue: vi.fn(), labels: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.db }));
vi.mock("@/lib/client-groups/queries", () => ({ readGroups: mocks.catalogue, readClientGroups: mocks.labels }));
import { readProfileGroups } from "@/lib/client-groups/profile";
describe("profile groups read boundary", () => {
  it("nonowner/nonoverview returns unavailable without creating a session DB or reading groups", async () => {
    expect(await readProfileGroups("s", "c", false)).toEqual({ catalogue: { available: false }, assigned: { available: false } });
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.catalogue).not.toHaveBeenCalled(); expect(mocks.labels).not.toHaveBeenCalled();
  });
  it("owner overview scopes the dependent display read to that one client", async () => {
    const db = {}; const group = { id: "g", name: "Paused", updated_at: "2030-01-01T00:00:00Z" };
    mocks.db.mockResolvedValue(db); mocks.catalogue.mockResolvedValue({ available: true, value: [group] });
    mocks.labels.mockResolvedValue({ available: true, value: new Map([["c", [group]]]) });
    expect((await readProfileGroups("s", "c", true)).assigned).toEqual({ available: true, value: [group] });
    expect(mocks.labels).toHaveBeenCalledWith(db, "s", true, ["c"], { available: true, value: [group] });
  });
});
