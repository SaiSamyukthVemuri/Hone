import { describe, expect, it } from "vitest";

import { warningKey } from "@/lib/machines/range-warnings";
import type { RangeWarning } from "@/lib/machines/range-warnings";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RangeConfirmationList } = await import(
  "@/components/machines/range-confirmation-list"
);

const W: RangeWarning = {
  groupId: "g1",
  stageKey: null,
  fieldKey: "current",
  value: 250,
  code: "outside_published_specification",
  message: "250 falls outside the published maximum 200.",
};

const render = (over: Partial<Parameters<typeof RangeConfirmationList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RangeConfirmationList, {
      warnings: [W],
      confirmed: new Set<string>(),
      disabled: false,
      labelFor: () => "Current",
      onToggle: () => {},
      ...over,
    }),
  );

describe("RangeConfirmationList", () => {
  it("renders nothing when no value is out of range", () => {
    expect(render({ warnings: [] })).toBe("");
  });

  it("shows the value as typed, the reason, and an UNCHECKED box", () => {
    const html = render();
    expect(html).toContain("Current: 250.");
    expect(html).toContain("250 falls outside the published maximum 200.");
    expect(html).toContain('data-testid="range-confirm"');
    expect(html).not.toContain("checked=");
  });

  it("shows the box checked once that exact warning is confirmed", () => {
    expect(render({ confirmed: new Set([warningKey(W)]) })).toContain("checked=");
  });

  it("disables the box while the payload is frozen", () => {
    expect(render({ disabled: true })).toContain("disabled");
  });
});
