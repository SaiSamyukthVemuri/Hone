import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MobileDayTimeline } from "@/app/(app)/calendar/MobileDayTimeline";
import { AppointmentPreviewDrawer } from "@/app/(app)/calendar/AppointmentPreviewDrawer";
import {
  CARD_LINE_PX,
  calendarPractitionerIdentity,
  practitionerRowFits,
} from "@/lib/calendar/practitioner-identity";
import { PRACTITIONER_COLORS } from "@/lib/practitioner-colors";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";

// HON-48: the team calendar names each appointment's practitioner beside a
// swatch in that practitioner's configured color. The card fill stays
// service-colored, the name is always printed (color is never the only cue),
// and appointment status (incl. no-show) stays distinguishable. Display only:
// no new query, so which appointments a viewer sees is unchanged (HON-44).

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const MOBILE = read("app/(app)/calendar/CalendarMobileDayView.tsx");
const HELPER = read("lib/calendar/practitioner-identity.ts");

// A synthetic five-practitioner, part-time roster in America/Los_Angeles: one
// appointment each, an hour apart, so every card renders on its own.
const TZ = "America/Los_Angeles";
const ROSTER = [
  { color: "rose", display_name: "Synthetic Practitioner A" },
  { color: "amber", display_name: "Synthetic Practitioner B" },
  { color: "emerald", display_name: "Synthetic Practitioner C" },
  { color: "indigo", display_name: "Synthetic Practitioner D" },
  { color: "not-a-token", display_name: "Synthetic Practitioner E" },
];
// 2030-03-01 is PST (UTC-8): 18:00Z = 10:00 local.
const appointments = ROSTER.map((p, i) => ({
  id: `synthetic-appointment-${i}`,
  starts_at: `2030-03-01T${18 + i}:00:00Z`,
  ends_at: `2030-03-01T${18 + i}:45:00Z`,
  duration_minutes: 45,
  status: i === 2 ? "no_show" : "confirmed",
  client: { id: `synthetic-client-${i}`, name: `Synthetic client ${i}` },
  service: null,
  practitioner: { id: `synthetic-practitioner-${i}`, ...p },
} as unknown as AppointmentWithPractitionerColor));

function renderDay(showPractitioner?: boolean): string {
  return renderToStaticMarkup(createElement(MobileDayTimeline, {
    date: "2030-03-01", appts: appointments, timedBlocks: [], recurringBreaks: [],
    availability: null, closedDay: false, isToday: false, tz: TZ,
    timeFormat: "12h", returnTo: "?view=day", onBookAt: () => {}, onEditBlock: () => {},
    ...(showPractitioner === undefined ? {} : { showPractitioner }),
  }));
}

const bg = (token: string) => PRACTITIONER_COLORS.find((c) => c.token === token)!.bg;

describe("calendarPractitionerIdentity", () => {
  it("returns the trimmed name and the configured color's swatch", () => {
    expect(calendarPractitionerIdentity({ color: "teal", display_name: "  Name  " }))
      .toEqual({ name: "Name", swatchClass: bg("teal"), colorLabel: "Teal" });
  });
  it("falls back to the neutral swatch for an unknown or missing color", () => {
    expect(calendarPractitionerIdentity({ color: "bogus", display_name: "N" })?.swatchClass)
      .toBe(bg("neutral"));
    expect(calendarPractitionerIdentity({ color: null, display_name: "N" })?.swatchClass)
      .toBe(bg("neutral"));
  });
  it("returns null without a name, so a swatch never stands alone", () => {
    expect(calendarPractitionerIdentity(null)).toBeNull();
    expect(calendarPractitionerIdentity({ color: "rose", display_name: "  " })).toBeNull();
    expect(calendarPractitionerIdentity({ color: "rose" })).toBeNull();
  });
  it("is display-only: no query, no Supabase", () => {
    expect(HELPER).not.toMatch(/supabase|createClient|from\(/);
  });
});

describe("mobile team day: five practitioners, each named in their color", () => {
  it("renders every practitioner's name and configured swatch on their own card", () => {
    const html = renderDay(true);
    expect(html.match(/data-practitioner-tag=""/g)).toHaveLength(5);
    for (const p of ROSTER) expect(html).toContain(p.display_name);
    for (const token of ["rose", "amber", "emerald", "indigo"]) {
      expect(html).toContain(bg(token));
    }
    // the unknown token resolves to neutral rather than breaking the card
    expect(html).toContain(bg("neutral"));
  });
  it("keeps studio-local times and the no-show status distinguishable", () => {
    const html = renderDay(true);
    expect(html).toContain("10:00");
    expect(html).toContain("2:00");
    expect(html.match(/No-show/g)).toHaveLength(1);
  });
  it("shows no practitioner identity on a single-practitioner calendar", () => {
    for (const html of [renderDay(false), renderDay()]) {
      expect(html).not.toContain("data-practitioner-tag");
      expect(html).not.toContain("Synthetic Practitioner A");
      expect(html).toContain("Synthetic client 0");
    }
  });
  it("the mobile view passes the capacity flag through", () => {
    expect(MOBILE).toContain("showPractitioner={practitionerCapacityEnabled}");
  });
});

describe("desktop week card and preview", () => {
  it("the week card gates identity on the team calendar and keeps the service fill", () => {
    expect(DAYCOL).toMatch(
      // HON-48: a team day column names its practitioner in the header bar,
      // so its cards drop the in-card tag; the week card keeps it.
      /practitionerCapacityEnabled\s*&&\s*!teamColumn\s*\?\s*calendarPractitionerIdentity\(a\.practitioner\)\s*:\s*null/,
    );
    expect(DAYCOL).toMatch(/<PractitionerTag\s+identity=\{practitionerIdentity\}/);
    expect(DAYCOL).toContain("${appointmentCardClasses(a.service)}");
    // The one-line card's swatch has its name in the hover title.
    expect(DAYCOL).toMatch(/practitionerIdentity\?\.name,/);
    expect(DAYCOL).toContain("title={[...titleParts, statusTag].filter(Boolean).join(\" · \")}");
  });
  it("the preview names the practitioner with their swatch", () => {
    const html = renderToStaticMarkup(createElement(AppointmentPreviewDrawer, {
      appointment: appointments[2], studioTimezone: TZ, timeFormat: "12h",
      returnTo: "", onClose: () => {},
    }));
    expect(html).toContain("Practitioner");
    expect(html).toContain("Synthetic Practitioner C");
    expect(html).toContain(bg("emerald"));
    expect(html).toContain("No-show");
  });
});

// Codex P2 on #1064: a separate practitioner row clipped short cards and pushed
// the service row out of view. Short cards now carry the swatch + name on the
// time row instead; the separate row appears only when every row fits.
describe("short cards: the practitioner fits without displacing details", () => {
  const desktop = (h: number, serviceRow: boolean) =>
    practitionerRowFits(h, { bodyLinePx: CARD_LINE_PX.desktopBody, serviceRow });
  const mobile = (h: number, serviceRow: boolean) =>
    practitionerRowFits(h, { bodyLinePx: CARD_LINE_PX.mobileBody, serviceRow });

  it("no separate row on a 45-minute desktop card (43px) or a 30-minute mobile card (44px)", () => {
    expect(desktop(43, true)).toBe(false);
    expect(desktop(43, false)).toBe(false);
    expect(mobile(44, false)).toBe(false);
  });
  it("no separate row when it would push the service row out (60-minute card, 58px)", () => {
    expect(desktop(58, true)).toBe(false);
    expect(mobile(58, true)).toBe(false);
  });
  it("a separate row once time, client, practitioner and service all fit", () => {
    expect(desktop(47, false)).toBe(true);
    expect(desktop(60, true)).toBe(true);
    expect(mobile(48, false)).toBe(true);
    expect(mobile(61, true)).toBe(true);
  });

  const card = (minutes: number) => ({
    id: `synthetic-short-${minutes}`,
    starts_at: "2030-03-01T18:00:00Z",
    ends_at: new Date(Date.parse("2030-03-01T18:00:00Z") + minutes * 60_000).toISOString(),
    duration_minutes: minutes,
    status: "confirmed",
    client: { id: "synthetic-client-short", name: "Synthetic short client" },
    service: { id: "synthetic-service", name: "Synthetic service" },
    practitioner: { id: "synthetic-practitioner-short", color: "teal", display_name: "Synthetic Practitioner S" },
  } as unknown as AppointmentWithPractitionerColor);
  const renderOne = (minutes: number) => renderToStaticMarkup(createElement(MobileDayTimeline, {
    date: "2030-03-01", appts: [card(minutes)], timedBlocks: [], recurringBreaks: [],
    availability: null, closedDay: false, isToday: false, tz: TZ,
    timeFormat: "12h", returnTo: "?view=day", onBookAt: () => {}, onEditBlock: () => {},
    showPractitioner: true,
  }));
  const order = (html: string) => ({
    tag: html.indexOf("data-practitioner-tag"),
    client: html.indexOf("Synthetic short client"),
    service: html.indexOf("Synthetic service"),
  });

  it("a 30-minute mobile card names the practitioner on the time row, before the client", () => {
    const html = renderOne(30);
    expect(html.match(/data-practitioner-tag=""/g)).toHaveLength(1);
    expect(html).toContain("Synthetic Practitioner S");
    expect(html).toContain(bg("teal"));
    const o = order(html);
    expect(o.tag).toBeGreaterThan(-1);
    expect(o.tag).toBeLessThan(o.client);
  });
  it("a 60-minute mobile card keeps its service row and the practitioner on the time row", () => {
    const o = order(renderOne(60));
    expect(o.service).toBeGreaterThan(o.client);
    expect(o.tag).toBeLessThan(o.client);
  });
  it("a 90-minute mobile card gives the practitioner its own row between client and service", () => {
    const o = order(renderOne(90));
    expect(o.tag).toBeGreaterThan(o.client);
    expect(o.tag).toBeLessThan(o.service);
  });
  it("the desktop card uses the same fit rule with its own client line height", () => {
    expect(DAYCOL).toMatch(/practitionerRowFits\(height, \{\s*bodyLinePx: CARD_LINE_PX\.desktopBody,\s*serviceRow: serviceName !== null,/);
    expect(DAYCOL).toContain("practitionerIdentity && !practitionerRow &&");
    expect(DAYCOL).toContain("practitionerIdentity && practitionerRow &&");
  });
});
