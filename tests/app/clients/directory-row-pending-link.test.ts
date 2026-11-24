import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The whole-row profile link must acknowledge a tap (UI-01): an uncached profile navigation keeps the old page painted until the next one arrives, so a
// plain Link looks idle. This test sees the props the row gives PendingLink; the Details control must stay a plain, in-place link.
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ href, children, pendingLabel, className }: { href: string; children?: unknown; pendingLabel?: string; className?: string }) =>
    createElement("a", { href, "data-pending-label": pendingLabel, className }, children as never),
}));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/(app)/clients/[id]/actions", () => ({ unarchiveClientAction: async () => {} }));

import { DirectoryResults } from "@/app/(app)/clients/ClientsDirectory";
import { queryDirectory, parseDirectoryParams } from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";

const source = Array.from({ length: 3 }, (_, i) =>
  projectStaffRow({ id: `c${100 + i}`, name: `Client ${i}`, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null }),
);
const none = { nextAppointments: new Map<string, string>(), intake: new Map() };
const data = queryDirectory(source, none, parseDirectoryParams({}));
const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, lastVisit: "any" as const, page: 1 };
const html = renderToStaticMarkup(createElement(DirectoryResults, { state, data, lastVisits: new Map(), selectedId: null }));

describe("the whole-row profile link acknowledges a tap", () => {
  it("every row's profile link goes through PendingLink and says 'Opening client…'", () => {
    for (const r of data.rows) {
      const m = html.match(new RegExp(`<a href="/clients/${r.id}"[^>]*>`));
      expect(m, `row ${r.id}`).not.toBeNull();
      expect(m![0]).toContain('data-pending-label="Opening client…"');
    }
  });
  it("it keeps the whole-row overlay: not made `relative` by the wrapper (static!) and still covers the row (after:inset-0)", () => {
    const m = html.match(new RegExp(`<a href="/clients/${data.rows[0].id}"[^>]*>`))![0];
    expect(m).toContain("static!");
    expect(m).toContain("after:absolute");
    expect(m).toContain("after:inset-0");
  });
  it("Details stays an in-place link that does not go through PendingLink", () => {
    const m = html.match(/<a[^>]*aria-label="Details for Client 0"[^>]*>/)![0];
    expect(m).not.toContain("data-pending-label");
    expect(m).toContain('aria-expanded="false"');
    expect(m).toContain(`href="/clients?client=${data.rows[0].id}"`);
  });
});
