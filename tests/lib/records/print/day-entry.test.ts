import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dayPacketEntryHref } from "@/lib/records/print/day-entry";

const CLIENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TZ = "America/Toronto";
const NOW = new Date("2026-11-13T15:00:00.000Z"); // 10:00 on 13 Nov in Toronto
const OWNER = { role: "owner", active: true };
const href = (over: Partial<Parameters<typeof dayPacketEntryHref>[0]> = {}) =>
  dayPacketEntryHref({ viewer: OWNER, clientId: CLIENT, sessionStartedAt: "2026-11-10T16:30:00.000Z", timezone: TZ, now: NOW, ...over });

describe("the day packet entry link (HON-46): owner only, one client, one studio-local day", () => {
  it("an active owner gets a link carrying ONLY clientId and day", () => {
    const h = href();
    expect(h).toBe(`/records/print/day?clientId=${CLIENT}&day=2026-11-10`);
    const u = new URL(h!, "https://x.test");
    expect([...u.searchParams.keys()].sort()).toEqual(["clientId", "day"]);
    expect(u.pathname).toBe("/records/print/day");
    expect(u.hash).toBe("");
  });
  it("any other viewer gets NO link (non-owner roles, an inactive owner, an unknown role)", () => {
    for (const viewer of [
      { role: "practitioner", active: true },
      { role: "receptionist", active: true },
      { role: "viewer", active: true },
      { role: "owner", active: false },
      { role: "", active: true },
    ]) expect(href({ viewer }), JSON.stringify(viewer)).toBeNull();
  });
  it("the day is the STUDIO-LOCAL date of the session start, not the UTC date", () => {
    // 03:30Z on 11 Nov is still 10 Nov in Toronto, already 11 Nov in Auckland.
    expect(href({ sessionStartedAt: "2026-11-11T03:30:00.000Z" })).toMatch(/day=2026-11-10$/);
    expect(href({ sessionStartedAt: "2026-11-11T03:30:00.000Z", timezone: "Pacific/Auckland" })).toMatch(/day=2026-11-11$/);
  });
  it("today is printable; a day after the studio's today gets no link", () => {
    expect(href({ sessionStartedAt: "2026-11-13T14:00:00.000Z" })).toMatch(/day=2026-11-13$/);
    expect(href({ sessionStartedAt: "2026-11-14T14:00:00.000Z" })).toBeNull();
    // 03:00Z on 14 Nov is still 13 Nov in Toronto (printable) but 14 Nov in Auckland (future there).
    const late = new Date("2026-11-14T03:00:00.000Z");
    expect(href({ sessionStartedAt: "2026-11-14T02:00:00.000Z", now: late })).toMatch(/day=2026-11-13$/);
    expect(href({ sessionStartedAt: "2026-11-14T02:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toMatch(/day=2026-11-14$/);
    // The guard is by DATE: a later time on the studio's own today still prints; only a later date does not.
    expect(href({ sessionStartedAt: "2026-11-14T08:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toMatch(/day=2026-11-14$/);
    expect(href({ sessionStartedAt: "2026-11-15T08:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toBeNull();
  });
  it("no usable start, a bad client id or an unresolvable timezone gives no link", () => {
    for (const sessionStartedAt of [null, undefined, "", "not a date"]) expect(href({ sessionStartedAt }), String(sessionStartedAt)).toBeNull();
    for (const clientId of ["", "abc", `${CLIENT}x`, "0a1b2c3d-4e5f-4a6b-8c7d", "'; drop table--"]) expect(href({ clientId }), clientId).toBeNull();
    expect(href({ timezone: "Not/AZone" })).toBeNull();
  });
  it("a day outside 1900-2100 gets no link", () => {
    expect(href({ sessionStartedAt: "1899-06-01T12:00:00.000Z" })).toBeNull();
  });
  it("lower-cases the client id (the page lower-cases it too)", () => {
    expect(href({ clientId: CLIENT.toUpperCase() })).toContain(`clientId=${CLIENT}`);
  });
});

describe("the session page wires the link without weakening it (source contract)", () => {
  const PAGE = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
  const link = PAGE.slice(PAGE.indexOf("{printDayHref !== null && ("), PAGE.indexOf("Print this day&rsquo;s record"));
  it("renders only when the helper returned an href, and builds it nowhere else", () => {
    expect(PAGE).toContain("dayPacketEntryHref({");
    expect(PAGE).toContain("{printDayHref !== null && (");
    expect(PAGE.match(/\/records\/print\/day(?![-\w])/g) ?? []).toHaveLength(0); // the path literal lives only in day-entry.ts
  });
  it("is never prefetched and sends no referrer (opening it runs the audit and the clinical read)", () => {
    expect(link).toContain("prefetch={false}");
    expect(link).toContain('referrerPolicy="no-referrer"');
    expect(link).toContain("href={printDayHref}");
  });
  it("passes the real viewer, the route's client id and the studio timezone, and nothing from the URL query", () => {
    expect(PAGE).toMatch(/dayPacketEntryHref\(\{\s*viewer: practitioner,\s*clientId: id,\s*sessionStartedAt: session\.started_at,\s*timezone: studio\.timezone,\s*\}\)/);
  });
  it("the helper file is the only builder of the path and holds no I/O or logging", () => {
    const src = readFileSync("lib/records/print/day-entry.ts", "utf8");
    expect(src).toContain('export const DAY_PACKET_PATH = "/records/print/day"');
    expect(src).not.toMatch(/console\.|fetch\(|supabase|process\.env/);
  });
});
