import { describe, expect, it, vi } from "vitest";
import { chartingViewForPage } from "@/lib/charting/page-view";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const stored = (v: unknown) => vi.fn(async () => ({ full_name: "Avery Example", charting_view: v }));

describe("the kill switch, end to end (the decision the page makes)", () => {
  it.each([undefined, null, "", "  ", "off", "garbage"])(
    "env %j: no toggle, Current, even with New stored, and the profile is not even read",
    async (raw) => {
      const read = stored("new");
      expect(await chartingViewForPage({ studioId: A, rawGate: raw, readMetadata: read })).toEqual({
        toggleVisible: false,
        view: "current",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("a list that does not name this studio is the same as off", async () => {
    const read = stored("new");
    expect(await chartingViewForPage({ studioId: A, rawGate: B, readMetadata: read })).toEqual({
      toggleVisible: false,
      view: "current",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("'all' shows the toggle and honours the stored choice", async () => {
    expect(await chartingViewForPage({ studioId: A, rawGate: "all", readMetadata: stored("new") })).toEqual({
      toggleVisible: true,
      view: "new",
    });
    expect(await chartingViewForPage({ studioId: A, rawGate: "all", readMetadata: stored("current") })).toEqual({
      toggleVisible: true,
      view: "current",
    });
  });
  it("a list naming this studio shows the toggle", async () => {
    expect(await chartingViewForPage({ studioId: A, rawGate: `${B},${A}`, readMetadata: stored("new") })).toEqual({
      toggleVisible: true,
      view: "new",
    });
  });
  it("nothing stored, something unexpected stored, or a failed read all mean Current (with the toggle still shown)", async () => {
    for (const read of [async () => undefined, async () => ({}), stored("NEW"), stored(7), async () => { throw new Error("down"); }]) {
      expect(await chartingViewForPage({ studioId: A, rawGate: "all", readMetadata: read })).toEqual({
        toggleVisible: true,
        view: "current",
      });
    }
  });
});
