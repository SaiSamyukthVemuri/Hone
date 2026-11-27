import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { formatEventTime, leadConsoleUrl, renderPlatformLeadAlert } from "@/lib/platform-leads/alert-email";

// LEAD-ALERT-01 (#826): the operator alert is a BRIEF notice with no prospect details.

const LEAD_ID = "0b7f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f";
const ORIGIN = "https://hone.example";
const URL_ = leadConsoleUrl(ORIGIN, "demo_request", LEAD_ID);
const AT = "2026-10-11T18:05:42.123Z";

describe("renderPlatformLeadAlert", () => {
  it("a demo request: a generic subject, the time, one link, and the sign-in note", () => {
    const out = renderPlatformLeadAlert({ kind: "demo_request", eventAt: AT }, URL_);
    expect(out.subject).toBe("New Hone demo request");
    expect(out.text).toContain("A new Hone demo request was saved.");
    expect(out.text).toContain("Received: 2026-10-11 18:05 UTC");
    expect(out.text).toContain("sign-in required");
    expect(out.html).toContain(`<a href="${ORIGIN}/admin">`);
    expect(out.html).toContain("sign-in required");
  });

  it("an early-access signup says so", () => {
    const out = renderPlatformLeadAlert({ kind: "early_access", eventAt: AT }, URL_);
    expect(out.subject).toBe("New Hone early-access signup");
    expect(out.text).toContain("A new Hone early-access signup was saved.");
  });

  it("carries NO prospect detail: the renderer is not even handed any, and nothing submitted can appear", () => {
    // The content type holds the kind and the time and nothing else. Extra fields smuggled in at runtime are never read.
    const hostile = {
      kind: "demo_request",
      eventAt: AT,
      name: "Avery Lead",
      email: "avery@prospect.test",
      practiceName: "Maple Clinic",
      location: "Toronto",
      practiceType: "laser",
      practitionerCount: "2-5",
      currentTool: "Paper charts",
      notes: "private notes",
    } as unknown as Parameters<typeof renderPlatformLeadAlert>[0];
    const out = renderPlatformLeadAlert(hostile, URL_);
    const all = `${out.subject}\n${out.text}\n${out.html}`;
    for (const detail of ["Avery", "avery@", "prospect.test", "Maple", "Toronto", "laser", "2 to 5", "Paper charts", "private notes"]) {
      expect(all, detail).not.toContain(detail);
    }
  });

  it("one link only, to the /admin lead list; the subject carries no time or detail", () => {
    const out = renderPlatformLeadAlert({ kind: "demo_request", eventAt: AT }, URL_);
    expect([...out.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([`${ORIGIN}/admin`]);
    expect([...out.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([`${ORIGIN}/admin`]);
    expect(out.subject).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("is deterministic: the same lead renders the same bytes (every retry reuses its keys)", () => {
    const a = renderPlatformLeadAlert({ kind: "demo_request", eventAt: AT }, URL_);
    const b = renderPlatformLeadAlert({ kind: "demo_request", eventAt: AT }, URL_);
    expect(a).toEqual(b);
  });

  it("a malformed time is said plainly, never a throw", () => {
    expect(renderPlatformLeadAlert({ kind: "demo_request", eventAt: "not a time" }, URL_).text).toContain("Time not recorded");
  });
});

describe("helpers", () => {
  it("the time is the event's own, in UTC", () => {
    expect(formatEventTime("2026-01-02T03:04:59.999Z")).toBe("2026-01-02 03:04 UTC");
    expect(formatEventTime("not a time")).toBe("Time not recorded");
  });

  it("the console link is the configured origin plus the /admin lead lists, whatever the trailing slashes", () => {
    expect(leadConsoleUrl("https://hone.example//", "demo_request", LEAD_ID)).toBe("https://hone.example/admin");
    expect(leadConsoleUrl("https://hone.example", "early_access", LEAD_ID)).toBe("https://hone.example/admin");
  });
});

describe("every link in the email resolves to a page that exists on this tree", () => {
  const routeFile = (pathname: string) => {
    const dir = pathname === "/" ? "app" : `app${pathname}`;
    return existsSync(`${dir}/page.tsx`) || existsSync(`app/(app)${pathname}/page.tsx`);
  };

  for (const kind of ["demo_request", "early_access"] as const) {
    it(`${kind}: each URL in the html and the text names an existing route`, () => {
      const out = renderPlatformLeadAlert({ kind, eventAt: AT }, leadConsoleUrl(ORIGIN, kind, LEAD_ID));
      const found = [...`${out.html}\n${out.text}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
      expect(found.length).toBeGreaterThan(0);
      for (const u of found) {
        const parsed = new URL(u);
        expect(parsed.origin, u).toBe(ORIGIN);
        expect(routeFile(parsed.pathname), `${u} has no page.tsx in app/`).toBe(true);
      }
    });
  }

  it("never links to the one-lead page, which is a follow-up and does not exist yet", () => {
    const out = renderPlatformLeadAlert({ kind: "demo_request", eventAt: AT }, URL_);
    expect(`${out.html}${out.text}`).not.toContain("/admin/leads/");
    expect(existsSync("app/admin/leads")).toBe(false);
  });
});
