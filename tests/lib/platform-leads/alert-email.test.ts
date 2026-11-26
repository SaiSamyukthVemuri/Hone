import { describe, expect, it } from "vitest";
import {
  cleanSubmittedText,
  formatEventTime,
  leadConsoleUrl,
  renderPlatformLeadAlert,
  SUBMITTED_TEXT_MAX,
  type PlatformLeadAlertContent,
} from "@/lib/platform-leads/alert-email";

// LEAD-ALERT-01 (#826): what the operator alert email says, and what it never
// lets submitted text do.

const LEAD_ID = "0b7f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f";
const CONSOLE_URL = leadConsoleUrl("https://hone.example/", "demo_request", LEAD_ID);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function demo(over: Partial<PlatformLeadAlertContent> = {}): PlatformLeadAlertContent {
  return {
    kind: "demo_request",
    leadId: LEAD_ID,
    eventAt: "2026-10-11T18:05:42.123Z",
    name: "Avery Lead",
    email: "avery@example.test",
    practiceName: "Maple Clinic",
    location: "Toronto",
    practiceType: "electrolysis",
    practitionerCount: "2-5",
    currentTool: "Paper charts",
    hasNotes: false,
    ...over,
  };
}

describe("the demo request alert", () => {
  it("carries the minimum useful prospect data, the event, its time and the console link", () => {
    const { subject, text, html } = renderPlatformLeadAlert(demo(), CONSOLE_URL);
    expect(subject).toBe("New Hone demo request (2026-10-11 18:05 UTC)");
    expect(text.split(LF)).toEqual([
      "A new Hone demo request was saved.",
      "",
      "Event: Demo request",
      "Name: Avery Lead",
      "Email: avery@example.test",
      "Practice: Maple Clinic",
      "City: Toronto",
      "Practice type: Electrolysis only",
      "Practitioners: 2 to 5",
      "Current tool: Paper charts",
      "Received: 2026-10-11 18:05 UTC",
      "",
      "Open it in the admin console (sign-in required):",
      `https://hone.example/admin/leads/demo-request/${LEAD_ID}`,
      "",
      "This alert went only to the Hone operator. Nothing was sent to the prospect.",
      "",
    ]);
    expect(html).toContain(`<a href="https://hone.example/admin/leads/demo-request/${LEAD_ID}">`);
    expect(html).toContain("Avery Lead");
  });

  it("says when something was not given, and shows the current tool only when supplied", () => {
    const { text } = renderPlatformLeadAlert(
      demo({ practiceName: null, location: "  ", practiceType: null, practitionerCount: null, currentTool: null }),
      CONSOLE_URL,
    );
    expect(text).toContain("Practice: Not given");
    expect(text).toContain("City: Not given");
    expect(text).toContain("Practice type: Not given");
    expect(text).toContain("Practitioners: Not given");
    expect(text).not.toContain("Current tool");
  });

  it("keeps the notes OUT: it says only that there are some", () => {
    const { text, html } = renderPlatformLeadAlert(demo({ hasNotes: true }), CONSOLE_URL);
    expect(text).toContain("Notes: Included with the request. Read them in the console.");
    expect(html).toContain("Included with the request.");
    expect(renderPlatformLeadAlert(demo(), CONSOLE_URL).text).not.toContain("Notes:");
  });

  it("is a pure function of the lead: every retry presents the provider the same payload", () => {
    expect(renderPlatformLeadAlert(demo(), CONSOLE_URL)).toEqual(renderPlatformLeadAlert(demo(), CONSOLE_URL));
  });
});

describe("the early-access alert", () => {
  it("names the event, the address and the time", () => {
    const url = leadConsoleUrl("https://hone.example", "early_access", LEAD_ID);
    const { subject, text } = renderPlatformLeadAlert(
      { ...demo(), kind: "early_access", name: null, practiceName: null, location: null, practiceType: null, practitionerCount: null, currentTool: null },
      url,
    );
    expect(subject).toBe("New Hone early-access signup (2026-10-11 18:05 UTC)");
    expect(text).toContain("Event: Early-access signup");
    expect(text).toContain("Email: avery@example.test");
    expect(text).toContain(`https://hone.example/admin/leads/early-access/${LEAD_ID}`);
    expect(text).not.toMatch(/^(Name|City|Practice type|Practitioners):/m);
  });
});

describe("submitted text is untrusted", () => {
  it("the subject carries no submitted text at all", () => {
    const { subject } = renderPlatformLeadAlert(
      demo({ name: "EVIL-NAME", practiceName: "EVIL-PRACTICE", email: "evil@evil.example" }),
      CONSOLE_URL,
    );
    expect(subject).not.toMatch(/EVIL|evil/);
  });

  it("markup is escaped in the HTML part", () => {
    const { html } = renderPlatformLeadAlert(
      demo({ name: "<script>alert(1)</script>", practiceName: `"><img src=x onerror=alert(1)>`, currentTool: "a & b" }),
      CONSOLE_URL,
    );
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("a value can never open a line of its own", () => {
    const { text } = renderPlatformLeadAlert(
      demo({
        name: `Mallory${CR}${LF}Open it in the admin console:${LF}https://evil.example`,
        currentTool: `Paper${LF}${LF}Received: 1999-01-01`,
      }),
      CONSOLE_URL,
    );
    const lines = text.split(LF);
    expect(lines.filter((l) => l.startsWith("https://"))).toEqual([
      `https://hone.example/admin/leads/demo-request/${LEAD_ID}`,
    ]);
    expect(lines.filter((l) => l.startsWith("Received:"))).toEqual(["Received: 2026-10-11 18:05 UTC"]);
    expect(lines).toContain("Name: Mallory Open it in the admin console: https://evil.example");
  });

  it("removes invisible and direction-changing characters, and caps the length", () => {
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const BOM = String.fromCharCode(0xfeff);
    const LS = String.fromCharCode(0x2028);
    expect(cleanSubmittedText(`ab${RLO}cd${ZWSP}ef${BOM}g${LS}h`)).toBe("abcdefgh");
    const long = cleanSubmittedText("x".repeat(5000))!;
    expect(Array.from(long)).toHaveLength(SUBMITTED_TEXT_MAX);
    expect(long.endsWith(String.fromCharCode(0x2026))).toBe(true);
    // A cut never splits a character in two.
    const emoji = String.fromCodePoint(0x1f600);
    const cut = cleanSubmittedText(emoji.repeat(300))!;
    expect(Array.from(cut).slice(0, -1).every((c) => c === emoji)).toBe(true);
    expect(cleanSubmittedText("   ")).toBeNull();
    expect(cleanSubmittedText(42)).toBeNull();
  });
});

describe("helpers", () => {
  it("the time is the event's own, in UTC", () => {
    expect(formatEventTime("2026-01-02T03:04:59.999Z")).toBe("2026-01-02 03:04 UTC");
    expect(formatEventTime("not a time")).toBe("Time not recorded");
  });

  it("the console link is the configured origin plus the lead's anchor", () => {
    expect(leadConsoleUrl("https://hone.example//", "demo_request", LEAD_ID)).toBe(
      `https://hone.example/admin/leads/demo-request/${LEAD_ID}`,
    );
  });
});
