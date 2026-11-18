import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// FormattedDateTime fills in on the client after mount (its server render is empty), so the test stands in for it and exposes the iso and format it was given.
vi.mock("@/components/formatted-date-time", () => ({
  FormattedDateTime: ({ iso, format }: { iso: string; format?: string }) => `[date:${format}:${iso}]`,
}));
import { FromLastVisitBand } from "@/components/from-last-visit-band";

// HON-10: the "From last visit, for today" band names the visit its note was written on, using the same date component as the "Last treatment" card.
// The band follows the newest NOTE-BEARING session and the card the newest CHARTED one, so they can differ; each names its own. Behavioural render
// of the real component, plus pins that the page uses it and the card's date component is the same one.

const PAGE = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
const CARD = readFileSync("components/last-treatment-memory-card.tsx", "utf8");
const render = (session: { id: string; startedAt: string } | null) =>
  renderToStaticMarkup(FromLastVisitBand({ note: "Plan A for today", session, clientId: "client-1" }));

describe("the band names its own visit", () => {
  it("links to the NOTE's session (not the card's) and shows that session's date", () => {
    const html = render({ id: "note-visit-7", startedAt: "2026-10-01T09:30:00.000Z" });
    expect(html).toContain('href="/clients/client-1/sessions/note-visit-7"');
    expect(html).toContain('data-testid="from-last-visit-link"');
    expect(html).toContain("Open that visit");
    expect(html).toContain("Written at the visit on");
    expect(html).toContain("[date:date:2026-10-01T09:30:00.000Z]");
    expect(html).toContain("Plan A for today");
  });
  it("two different note visits produce two different links and dates (it follows its own session, nothing else)", () => {
    const a = render({ id: "visit-a", startedAt: "2026-09-01T10:00:00.000Z" });
    const b = render({ id: "visit-b", startedAt: "2026-10-08T10:00:00.000Z" });
    expect(a).toContain("[date:date:2026-09-01T10:00:00.000Z]");
    expect(b).toContain("[date:date:2026-10-08T10:00:00.000Z]");
    expect(a).not.toContain("2026-10-08");
    expect(a).toContain("/sessions/visit-a");
    expect(a).not.toContain("visit-b");
    expect(b).toContain("/sessions/visit-b");
    expect(b).not.toContain("visit-a");
  });
  it("encodes the ids in the link", () => {
    expect(render({ id: "a/b?c", startedAt: "2026-10-01T09:30:00.000Z" })).toContain("/sessions/a%2Fb%3Fc");
  });
  it("no identity block when the loader returned no session; the note text is still there", () => {
    const html = render(null);
    expect(html).not.toContain("from-last-visit-identity");
    expect(html).toContain("Plan A for today");
  });
  it("the page hands the band the loader's session (never the card's), and the card uses the same date component and format", () => {
    expect(PAGE).toMatch(/<FromLastVisitBand note=\{fromLastVisit\} session=\{previousVisit\.session\} clientId=\{id\} \/>/);
    expect(CARD).toMatch(/<FormattedDateTime iso=\{memory\.startedAt\} format="date" \/>/);
    const bandSrc = readFileSync("components/from-last-visit-band.tsx", "utf8");
    expect(bandSrc).toMatch(/<FormattedDateTime iso=\{session\.startedAt\} format="date" \/>/);
  });
});
