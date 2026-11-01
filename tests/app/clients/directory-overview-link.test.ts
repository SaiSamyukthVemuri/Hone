import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ href, children }: { href: string; children?: unknown }) => createElement("a", { href }, children as never),
}));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/(app)/clients/[id]/actions", () => ({ unarchiveClientAction: async () => {} }));

import { ClientOverview, DirectoryResults } from "@/app/(app)/clients/ClientsDirectory";
import { queryDirectory, parseDirectoryParams } from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";

// Codex P2 (4a7e9e8f): opening an overview from page 2 must keep page 2, and Close must return to it.
const render = (state: Parameters<typeof DirectoryResults>[0]["state"], data: Parameters<typeof DirectoryResults>[0]["data"], selectedId: string | null) =>
  renderToStaticMarkup(createElement(DirectoryResults, { state, data, lastVisits: new Map(), selectedId }));

describe("overview links keep the results page", () => {
  const source = Array.from({ length: 40 }, (_, i) =>
    projectStaffRow({ id: `c${100 + i}`, name: `Client ${String(i).padStart(2, "0")}`, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null }),
  );
  const none = { nextAppointments: new Map<string, string>(), intake: new Map() };

  it("the row link carries ?page=2 and the Close link returns to page 2 with no fragment", () => {
    const data = queryDirectory(source, none, { ...parseDirectoryParams({}), page: 2 });
    expect(data.page).toBe(2);
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: data.page };
    const first = data.rows[0].id;
    const html = render(state, data, null);
    expect(html).toContain(`href="/clients?page=2&amp;client=${first}"`);
    const open = renderToStaticMarkup(
      createElement(ClientOverview, { state, row: data.rows[0], lastVisit: { kind: "none" }, page: data.page }),
    );
    expect(open).toContain(`href="/clients?page=2"`);
    expect(open).not.toContain("#");
  });

  it("control: page 1 carries no page parameter", () => {
    const data = queryDirectory(source, none, parseDirectoryParams({}));
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: 1 };
    const html = render(state, data, null);
    expect(html).toContain(`href="/clients?client=${data.rows[0].id}"`);
  });
});

// HON-58 shared UI lesson: no anchor or field jumps; the overview opens in place and
// closing restores the state; every control is visible and a real target.
describe("directory interaction contract (HON-58)", () => {
  const source = Array.from({ length: 5 }, (_, i) =>
    projectStaffRow({ id: `c${200 + i}`, name: `Person ${i}`, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null }),
  );
  const none = { nextAppointments: new Map<string, string>(), intake: new Map() };
  const read = (f: string) => readFileSync(`app/(app)/clients/${f}`, "utf8");

  it("the overview renders INSIDE the selected row's item, so nothing above it moves", () => {
    const data = queryDirectory(source, none, parseDirectoryParams({}));
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: 1 };
    const id = data.rows[2].id;
    const html = renderToStaticMarkup(
      createElement(DirectoryResults, {
        state, data, lastVisits: new Map(), selectedId: id,
        overview: createElement(ClientOverview, { state, row: data.rows[2], lastVisit: { kind: "none" }, page: 1 }),
      }),
    );
    const item = html.slice(html.indexOf(`<li id="client-${id}"`));
    const end = item.indexOf("</li>");
    expect(item.slice(0, end)).toContain("client-overview-title-");
    expect(html.match(/client-overview-title-/g)).toHaveLength(2); // aria-labelledby + heading id, once
    expect(html).toContain('aria-current="true"');
  });

  it("no directory link carries a #fragment, and row links do not scroll", () => {
    const data = queryDirectory(source, none, parseDirectoryParams({}));
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: 1 };
    const html = render(state, data, data.rows[0].id);
    expect(html).not.toMatch(/href="[^"]*#/);
    expect(read("ClientsDirectory.tsx")).not.toMatch(/#client-/);
    expect(read("OverviewFrame.tsx")).toContain("scroll={false}");
  });

  it("controls: client navigation without scroll, no dropdown, no search term echoed, 44px targets", () => {
    const src = read("DirectoryControls.tsx");
    expect(src).toContain('"use client"');
    expect(src).toContain("scroll: false");
    expect(src).not.toMatch(/<select|<option/);
    expect(src).not.toMatch(/\$\{state\.q\}|\$\{q\}/);
    expect(src).toContain("min-h-11");
    // Sort and filters apply on change; the typed search text is local state and survives them.
    expect(src).toMatch(/useState\(state\.q\)/);
  });

  it("the overview frame moves focus in on open and back to the row on close, and Escape closes", () => {
    const src = read("OverviewFrame.tsx");
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain(".focus({ preventScroll: true })");
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("overviewRowLinkId(clientId)");
  });

  it("a client module exports only components (the server page crashed calling a helper exported from one)", () => {
    for (const f of ["OverviewFrame.tsx", "DirectoryControls.tsx"]) {
      const src = read(f);
      expect(src).toContain('"use client"');
      const exported = [...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
      expect(exported.every((n) => /^[A-Z]/.test(n))).toBe(true);
    }
  });
});
