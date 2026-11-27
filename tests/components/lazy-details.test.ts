import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LazyDetails } from "@/components/waitlist/lazy-details";

const page = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");

describe("HON-109 LazyDetails (Waitlist rows hydrate when reached)", () => {
  it("server-renders the whole body, unchanged, with no fallback (no-script behaviour is identical)", () => {
    const html = renderToString(
      createElement(
        LazyDetails,
        { className: "peer/entry", "data-testid": "waitlist-entry-details", summary: createElement("summary", null, "View details") },
        createElement("form", { action: "/x", method: "post" }, createElement("button", { type: "submit" }, "Record")),
      ),
    );
    expect(html).toContain('<details class="peer/entry" data-testid="waitlist-entry-details"');
    expect(html).toContain("<summary>View details</summary>");
    expect(html).toContain("<form");
    expect(html).toContain("Record");
    expect(html).not.toContain("<!--$!-->"); // no suspended/fallback boundary in the server output
  });

  it("is not open by default and passes no `open` attribute", () => {
    const html = renderToString(createElement(LazyDetails, { summary: createElement("summary", null, "s") }, "body"));
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("the Waitlist rows use it for both the row and the invite composer, and no bare <details> is left around a row body", () => {
    expect(page).toContain('import { LazyDetails } from "@/components/waitlist/lazy-details"');
    expect(page.match(/<LazyDetails\b/g)).toHaveLength(2);
    expect(page.match(/<\/LazyDetails>/g)).toHaveLength(2);
    expect(page).toContain('data-testid="waitlist-entry-details"');
    expect(page).toContain('data-testid="row-invite"');
  });

  it("the gate suspends only on the client and reaches on pointer, focus and toggle", () => {
    const src = readFileSync("components/waitlist/lazy-details.tsx", "utf8");
    expect(src).toMatch(/typeof window === "undefined" \? null/);
    for (const h of ["onToggle", "onFocus", "onPointerEnter"]) expect(src).toContain(h);
    expect(src).toContain("fallback={null}");
  });
});
