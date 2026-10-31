import { describe, expect, it } from "vitest";
import { PRACTITIONER_COLORS } from "@/lib/practitioner-colors";
import {
  colourOptions,
  colourTokensTakenByOthers,
  duplicateColourTokens,
  shouldSuggestColour,
  suggestDistinctColour,
} from "@/lib/calendar/colour-assignment";

const h = (id: string, color: string | null) => ({ id, color });

describe("suggesting a distinct colour for a new practitioner", () => {
  it("is the first palette colour nobody else holds, never the default", () => {
    expect(suggestDistinctColour([h("me", "neutral")], "me")).toBe("rose");
    expect(suggestDistinctColour([h("me", "neutral"), h("a", "rose")], "me")).toBe("amber");
    expect(suggestDistinctColour([h("me", "neutral"), h("a", "rose"), h("b", "amber")], "me")).toBe("emerald");
  });
  it("ignores my own colour and the default other people sit on", () => {
    expect(suggestDistinctColour([h("me", "rose"), h("a", "neutral")], "me")).toBe("rose");
  });
  it("ignores unknown or corrupt stored tokens", () => {
    expect(suggestDistinctColour([h("me", "neutral"), h("a", "chartreuse"), h("b", null)], "me")).toBe("rose");
  });
  it("is null when every colour is taken", () => {
    const all = PRACTITIONER_COLORS.filter((c) => c.token !== "neutral").map((c, i) => h(`p${i}`, c.token));
    expect(suggestDistinctColour([h("me", "neutral"), ...all], "me")).toBeNull();
  });
  it("two new practitioners in turn get different colours", () => {
    const first = suggestDistinctColour([h("a", "neutral"), h("b", "neutral")], "a");
    const second = suggestDistinctColour([h("a", first), h("b", "neutral")], "b");
    expect(first).not.toBe(second);
  });
});

describe("existing colours stay stable", () => {
  it("only a practitioner still on the default is offered a suggestion", () => {
    expect(shouldSuggestColour("neutral")).toBe(true);
    expect(shouldSuggestColour(null)).toBe(true);
    expect(shouldSuggestColour("teal")).toBe(false);
    expect(shouldSuggestColour("rose")).toBe(false);
  });
});

describe("options and duplicates", () => {
  it("every palette colour is offered; a taken one is flagged, not removed", () => {
    const opts = colourOptions([h("me", "sky"), h("a", "rose"), h("b", "rose")], "me");
    expect(opts.map((o) => o.token)).toEqual(PRACTITIONER_COLORS.map((c) => c.token));
    expect(opts.find((o) => o.token === "rose")?.takenBy).toBe(2);
    expect(opts.find((o) => o.token === "sky")?.takenBy).toBe(0);
  });
  it("what others hold excludes me", () => {
    expect([...colourTokensTakenByOthers([h("me", "sky"), h("a", "rose")], "me")]).toEqual(["rose"]);
  });
  it("reports existing duplicates as information only", () => {
    expect(duplicateColourTokens([h("a", "rose"), h("b", "rose"), h("c", "neutral"), h("d", "neutral")])).toEqual(["rose"]);
    expect(duplicateColourTokens([h("a", "rose"), h("b", "sky")])).toEqual([]);
  });
});
