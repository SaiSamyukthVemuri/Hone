import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAY_PACKET_OPEN_PATH, dayPacketEntry } from "@/lib/records/print/day-entry";

const CLIENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TZ = "America/Toronto";
const NOW = new Date("2026-11-13T15:00:00.000Z"); // 10:00 on 13 Nov in Toronto
const OWNER = { role: "owner", active: true };
const entry = (over: Partial<Parameters<typeof dayPacketEntry>[0]> = {}) =>
  dayPacketEntry({ viewer: OWNER, clientId: CLIENT, sessionStartedAt: "2026-11-10T16:30:00.000Z", timezone: TZ, now: NOW, ...over });

describe("the day packet entry link (HON-46): owner only, one client, one studio-local day", () => {
  it("an active owner gets exactly the client id and the day, as values and never as a URL", () => {
    const e = entry();
    expect(e).toEqual({ clientId: CLIENT, day: "2026-11-10" });
    expect(Object.keys(e!).sort()).toEqual(["clientId", "day"]);
    expect(typeof e).toBe("object");
  });
  it("any other viewer gets NO entry (non-owner roles, an inactive owner, an unknown role)", () => {
    for (const viewer of [
      { role: "practitioner", active: true },
      { role: "receptionist", active: true },
      { role: "viewer", active: true },
      { role: "owner", active: false },
      { role: "", active: true },
    ]) expect(entry({ viewer }), JSON.stringify(viewer)).toBeNull();
  });
  it("the day is the STUDIO-LOCAL date of the session start, not the UTC date", () => {
    // 03:30Z on 11 Nov is still 10 Nov in Toronto, already 11 Nov in Auckland.
    expect(entry({ sessionStartedAt: "2026-11-11T03:30:00.000Z" })).toMatchObject({ day: "2026-11-10" });
    expect(entry({ sessionStartedAt: "2026-11-11T03:30:00.000Z", timezone: "Pacific/Auckland" })).toMatchObject({ day: "2026-11-11" });
  });
  it("today is printable; a day after the studio's today gets no entry", () => {
    expect(entry({ sessionStartedAt: "2026-11-13T14:00:00.000Z" })).toMatchObject({ day: "2026-11-13" });
    expect(entry({ sessionStartedAt: "2026-11-14T14:00:00.000Z" })).toBeNull();
    // 03:00Z on 14 Nov is still 13 Nov in Toronto (printable) but 14 Nov in Auckland (future there).
    const late = new Date("2026-11-14T03:00:00.000Z");
    expect(entry({ sessionStartedAt: "2026-11-14T02:00:00.000Z", now: late })).toMatchObject({ day: "2026-11-13" });
    expect(entry({ sessionStartedAt: "2026-11-14T02:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toMatchObject({ day: "2026-11-14" });
    // The guard is by DATE: a later time on the studio's own today still prints; only a later date does not.
    expect(entry({ sessionStartedAt: "2026-11-14T08:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toMatchObject({ day: "2026-11-14" });
    expect(entry({ sessionStartedAt: "2026-11-15T08:00:00.000Z", now: late, timezone: "Pacific/Auckland" })).toBeNull();
  });
  it("no usable start, a bad client id or an unresolvable timezone gives no link", () => {
    for (const sessionStartedAt of [null, undefined, "", "not a date"]) expect(entry({ sessionStartedAt }), String(sessionStartedAt)).toBeNull();
    for (const clientId of ["", "abc", `${CLIENT}x`, "0a1b2c3d-4e5f-4a6b-8c7d", "'; drop table--"]) expect(entry({ clientId }), clientId).toBeNull();
    expect(entry({ timezone: "Not/AZone" })).toBeNull();
  });
  it("a day outside 1900-2100 gets no entry", () => {
    expect(entry({ sessionStartedAt: "1899-06-01T12:00:00.000Z" })).toBeNull();
  });
  it("lower-cases the client id (the page lower-cases it too)", () => {
    expect(entry({ clientId: CLIENT.toUpperCase() })).toMatchObject({ clientId: CLIENT });
  });
});

describe("the session page wires the entry as a POST form without weakening it (source contract)", () => {
  const PAGE = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
  const form = PAGE.slice(PAGE.indexOf("{printDayEntry !== null && ("), PAGE.indexOf("Print this day&rsquo;s record"));
  it("renders only when the helper returned an entry, and names the open path only through the helper's constant", () => {
    expect(PAGE).toContain("dayPacketEntry({");
    expect(PAGE).toContain("{printDayEntry !== null && (");
    expect(PAGE.match(/["'`]\/records\/print\//g) ?? []).toHaveLength(0); // no print path literal in the page
    expect(DAY_PACKET_OPEN_PATH).toBe("/records/print/open");
  });
  it("is a POST form: the values go in the body, never in a URL; it has no rel=noreferrer (older Safari would send Origin: null and be refused)", () => {
    expect(form).toContain('method="post"');
    expect(form).toContain("action={DAY_PACKET_OPEN_PATH}");
    expect(form).not.toMatch(/rel=|referrerPolicy|referrerpolicy/i); // a same-origin POST whose Referer goes only to our own server
    expect(form).toContain('type="hidden" name="clientId"');
    expect(form).toContain('type="hidden" name="day"');
    expect(form).not.toMatch(/href=|<Link|router\.|window\.open|\?clientId|\?day/);
  });
  it("passes the real viewer, the route's client id and the studio timezone, and nothing from the URL query", () => {
    expect(PAGE).toMatch(/dayPacketEntry\(\{\s*viewer: practitioner,\s*clientId: id,\s*sessionStartedAt: session\.started_at,\s*timezone: studio\.timezone,\s*\}\)/);
  });
  it("the helper file never builds a URL and holds no I/O or logging", () => {
    const src = readFileSync("lib/records/print/day-entry.ts", "utf8");
    expect(src).toContain('export const DAY_PACKET_OPEN_PATH = "/records/print/open"');
    expect(src).not.toMatch(/URLSearchParams|\?clientId|searchParams|href/);
    expect(src).not.toMatch(/console\.|fetch\(|supabase|process\.env/);
  });
});
