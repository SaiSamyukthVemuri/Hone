import { describe, expect, it, vi } from "vitest";
import { chartingViewForPage } from "@/lib/charting/page-view";

const stored = (v: unknown) => vi.fn(async () => ({ full_name: "Avery Example", charting_view: v }));

describe("turning the rollout off, end to end (the decision the page makes)", () => {
  it("rollout off: no toggle, Current, even with New stored, and the profile is not even read", async () => {
    const read = stored("new");
    expect(await chartingViewForPage({ rolloutOn: false, readMetadata: read })).toEqual({ toggleVisible: false, view: "current" });
    expect(read).not.toHaveBeenCalled();
  });
  it("rollout on shows the toggle and honours the stored choice", async () => {
    expect(await chartingViewForPage({ rolloutOn: true, readMetadata: stored("new") })).toEqual({ toggleVisible: true, view: "new" });
    expect(await chartingViewForPage({ rolloutOn: true, readMetadata: stored("current") })).toEqual({ toggleVisible: true, view: "current" });
  });
  it("nothing stored, something unexpected stored, or a failed read all mean Current (with the toggle still shown)", async () => {
    for (const read of [async () => undefined, async () => ({}), stored("NEW"), stored(7), async () => { throw new Error("down"); }]) {
      expect(await chartingViewForPage({ rolloutOn: true, readMetadata: read })).toEqual({ toggleVisible: true, view: "current" });
    }
  });
});
