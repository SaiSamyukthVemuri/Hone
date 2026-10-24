import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthView } from "@/app/(app)/calendar/MonthView";

// HON-48 (Team review L1 on #1082): in the MONTH view a no-show was told apart
// from a done or completed visit by nothing but the shared dimming. A no-show
// chip now carries a dashed edge and a leading "No-show" label, and every
// terminal status reaches the chip's hover title. Synthetic data only.

const DAY = "2030-03-04";
const chip = (id: string, status: string, localTime: string, endsAt: string) => ({
  id, status, localTime,
  starts_at: `${DAY}T${localTime}:00Z`,
  ends_at: endsAt,
  service: { id: `synthetic-service-${id}`, name: `Synthetic service ${id}` },
});

const PAST_END = "2030-03-04T10:00:00Z";
const FUTURE_END = "2030-03-04T23:00:00Z";

function render(appts: ReturnType<typeof chip>[]): string {
  return renderToStaticMarkup(createElement(MonthView, {
    monthAnchor: DAY,
    appointmentsByDate: new Map([[DAY, appts]]) as never,
    blockedByDate: new Map(),
    today: DAY,
    isClosedDate: () => false,
  }));
}

// The chip element whose title starts with `time`.
function chipFor(html: string, time: string): string {
  const at = html.indexOf(`title="${time}`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<span", at);
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html.startsWith("<span", i)) depth++;
    if (html.startsWith("</span>", i) && --depth === 0) return html.slice(start, i + 7);
  }
  throw new Error("unterminated chip");
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2030-03-04T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("month view: a no-show chip is distinguishable without colour or opacity", () => {
  const html = () => render([
    chip("noshow", "no_show", "08:00", PAST_END),
    chip("done", "confirmed", "09:00", PAST_END),
    chip("completed", "completed", "07:30", PAST_END),
  ]);

  it("only the no-show chip has the dashed edge", () => {
    const h = html();
    expect(chipFor(h, "8:00")).toContain("border-dashed");
    expect(chipFor(h, "9:00")).not.toContain("border-dashed");
    expect(chipFor(h, "7:30")).not.toContain("border-dashed");
  });

  it("the no-show chip LEADS with its label, before the time and the service", () => {
    const c = chipFor(html(), "8:00");
    const body = c.slice(c.indexOf(">") + 1);
    const label = body.indexOf("No-show");
    expect(label).toBeGreaterThan(-1);
    expect(label).toBeLessThan(body.indexOf("8:00"));
    expect(label).toBeLessThan(body.indexOf("Synthetic service noshow"));
  });

  it("done and completed chips never say No-show, and stay dimmed as before", () => {
    const h = html();
    for (const t of ["9:00", "7:30"]) {
      expect(chipFor(h, t)).not.toContain("No-show");
      expect(chipFor(h, t)).toContain("opacity-60");
    }
    expect(chipFor(h, "8:00")).toContain("opacity-60");
  });

  it("every terminal status reaches the hover title", () => {
    const h = html();
    expect(h).toContain('title="8:00 · Synthetic service noshow · No-show"');
    expect(h).toContain('title="9:00 · Synthetic service done · Done"');
    expect(h).toContain('title="7:30 · Synthetic service completed · Completed"');
  });

  it("an upcoming chip is unchanged: no tag, no dash, not dimmed, title time · service", () => {
    const h = render([chip("upcoming", "confirmed", "15:00", FUTURE_END)]);
    const c = chipFor(h, "15:00");
    expect(c).not.toContain("border-dashed");
    expect(c).not.toContain("opacity-60");
    expect(h).toContain('title="15:00 · Synthetic service upcoming"');
  });
});
