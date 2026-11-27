import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WAITLIST_PATH } from "@/lib/waitlist/paths";

// AppMain decides which pages get the wider contained column (max-w-[86rem]) instead of the narrow default. Four pages share it, added by four
// different changes, so one merge can silently drop another's entry (a conflict resolved by keeping one side). Pin the list itself.
const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

const { AppMain } = await import("@/app/(app)/AppMain");

function layoutAt(pathname: string) {
  route.pathname = pathname;
  const html = renderToStaticMarkup(AppMain({ children: null }) as React.ReactElement);
  return { width: /data-width="([^"]+)"/.exec(html)?.[1], wideColumn: html.includes("max-w-[86rem]") };
}

describe("AppMain: which pages get the wider contained column", () => {
  const CONTAINED = ["/dashboard", "/clients", "/records", WAITLIST_PATH];

  for (const path of CONTAINED) {
    it(`${path} is contained and wide-columned (also with a trailing slash)`, () => {
      expect(layoutAt(path)).toEqual({ width: "contained", wideColumn: true });
      expect(layoutAt(`${path}/`)).toEqual({ width: "contained", wideColumn: true });
    });
  }

  it("the calendar is full width, not the contained column", () => {
    expect(layoutAt("/calendar")).toEqual({ width: "full", wideColumn: false });
  });

  it.each(["/settings", "/settings/", "/settings/services", "/settings/payments/fees"])(
    "%s shares the standard width with Notifications",
    (path) => expect(layoutAt(path)).toEqual(layoutAt("/notifications")),
  );

  it("a similarly named path keeps the normal width", () => {
    expect(layoutAt("/settings-help")).toEqual({ width: "contained", wideColumn: false });
  });

  it("a detail page keeps the default column", () => {
    expect(layoutAt("/clients/some-client-id")).toEqual({ width: "contained", wideColumn: false });
    expect(layoutAt("/records/print")).toEqual({ width: "contained", wideColumn: false });
  });
});
