import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupStateNotice } from "@/app/(app)/dashboard/setup-state-notice";
import type { SetupCardState } from "@/lib/dashboard/setup-card-model";

const html = (state: SetupCardState) => renderToStaticMarkup(createElement(SetupStateNotice, { state }));

describe("SetupStateNotice", () => {
  it("owner-paused booking is a stated choice with a change link, never a to-do", () => {
    const out = html({
      kind: "paused_by_owner",
      choices: [{ key: "admission_closed", label: "This studio is not accepting new clients.", href: "/settings/booking" }],
    });
    expect(out).toContain("New-client booking is off");
    expect(out).toContain("That is your setting, not unfinished setup.");
    expect(out).toContain('href="/settings/booking"');
    expect(out).not.toMatch(/complete your setup|finish setup/i);
  });

  it("finish-launch points at the Setup destination", () => {
    const out = html({ kind: "finish_launch" });
    expect(out).toContain('href="/settings/launch"');
    expect(out).toContain("Booking is ready");
  });

  it("other states render nothing here (the checklist card owns them)", () => {
    for (const kind of ["hidden", "unknown"] as const) expect(html({ kind })).toBe("");
    expect(html({ kind: "incomplete", remaining: 1, next: null, listMayBeIncomplete: false })).toBe("");
  });
});
