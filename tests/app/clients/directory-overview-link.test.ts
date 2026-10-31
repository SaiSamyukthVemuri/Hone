import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

  it("the row link carries ?page=2 and the Close link returns to page 2 at the row", () => {
    const data = queryDirectory(source, none, { ...parseDirectoryParams({}), page: 2 });
    expect(data.page).toBe(2);
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: data.page };
    const first = data.rows[0].id;
    const html = render(state, data, null);
    expect(html).toContain(`href="/clients?page=2&amp;client=${first}"`);
    const open = renderToStaticMarkup(
      createElement(ClientOverview, { state, row: data.rows[0], lastVisit: { kind: "none" }, page: data.page }),
    );
    expect(open).toContain(`href="/clients?page=2#client-${first}"`);
  });

  it("control: page 1 carries no page parameter", () => {
    const data = queryDirectory(source, none, parseDirectoryParams({}));
    const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, page: 1 };
    const html = render(state, data, null);
    expect(html).toContain(`href="/clients?client=${data.rows[0].id}"`);
  });
});
