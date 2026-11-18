import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay, telHref } from "@/lib/waitlist/reply-contact-pure";

vi.mock("@/app/(app)/settings/waitlist/follow-up-actions", () => ({
  eraseAnswersAction: vi.fn(),
  keepWithdrawalAction: vi.fn(),
  linkAppointmentAction: vi.fn(),
  markHandledAction: vi.fn(),
}));

const { DeclineFollowUpSection, OWNER_ANSWER_LABELS } = await import("@/components/waitlist/decline-follow-up-section");
const { emptyOutboxCounts } = await import("@/lib/waitlist/decline-status-lines");

const F = "11111111-1111-4111-8111-111111111111";
const row = (o: Record<string, unknown> = {}) =>
  ({
    followupId: F, entryId: "e1", invitationId: "i1", clientName: "Avery Example", kind: "decline", status: "open",
    whyNotWork: "WHYMARK", betterTimes: "BETTERMARK", answersErasedAt: null, eraseBy: "2027-02-07T10:00:00Z", closedAt: null, ...o,
  }) as never;
const render = (rows: unknown[], contact: unknown = { kind: "entry", email: "avery@example.test", phone: "4165550123" }) =>
  renderToStaticMarkup(
    createElement(DeclineFollowUpSection, {
      rows: rows as never, timeZone: "UTC", emailEnabled: true, outbox: new Map([["i1", emptyOutboxCounts()]]), linkable: new Map(), notice: null,
      contacts: new Map([["e1", contact as never]]), renderedEntryIds: new Set(["e1"]),
    }) as ReactElement,
  );
const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, `${needle} is rendered`).toBeGreaterThan(-1);
  return i;
};

describe("the response card's order", () => {
  it("name, More actions, email row, phone row, the response, Details, then the actions", () => {
    const html = render([row()]);
    const order = ["Avery Example", 'data-testid="more-actions"', 'data-testid="reply-contact-email"', 'data-testid="reply-contact-phone"', "WHYMARK", 'data-testid="response-details"', 'data-testid="response-actions"', "Book now"].map((n) => at(html, n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("the name and More actions share the header row, name first", () => {
    const html = render([row()]);
    const header = /<div[^>]*data-testid="response-header"[\s\S]*?<\/details><\/div>/.exec(html)?.[0] ?? "";
    expect(header.indexOf("Avery Example")).toBeGreaterThan(-1);
    expect(header.indexOf("Avery Example")).toBeLessThan(header.indexOf('data-testid="more-actions"'));
    expect(header).toContain("justify-between");
  });
  it("the contact rows have the same shape: value, then Email/Call, then Copy", () => {
    const html = render([row()]);
    const email = /data-testid="reply-contact-email"[\s\S]*?(?=data-testid="reply-contact-phone")/.exec(html)![0];
    const phone = /data-testid="reply-contact-phone"[\s\S]*?(?=<dl)/.exec(html)![0];
    expect(email.indexOf("avery@example.test")).toBeLessThan(email.indexOf(">Email<"));
    expect(email.indexOf(">Email<")).toBeLessThan(email.indexOf(">Copy<"));
    expect(phone.indexOf("(416) 555-0123")).toBeLessThan(phone.indexOf(">Call<"));
    expect(phone.indexOf(">Call<")).toBeLessThan(phone.indexOf(">Copy<"));
  });
});

describe("alignment", () => {
  it("every contact action has the same minimum width and a centred label, so the columns line up", () => {
    const html = render([row()]);
    const actions = [...html.matchAll(/<(?:a|button)[^>]*class="([^"]*)"[^>]*>(Email|Call|Copy)</g)];
    expect(actions.map((m) => m[2])).toEqual(["Email", "Copy", "Call", "Copy"]);
    for (const m of actions) expect(m[1]).toMatch(/min-w-\[5rem\].*justify-center|justify-center.*min-w-\[5rem\]/);
  });
  it("the name shares a 44px centre line with More actions, and only when More actions is there", () => {
    const withMore = render([row()]);
    expect(/<p class="[^"]*min-h-\[44px\][^"]*items-center[^"]*">Avery Example/.test(withMore)).toBe(true);
    const erased = render([row({ answersErasedAt: "2026-11-01T00:00:00Z", whyNotWork: null, betterTimes: null })]);
    expect(/<p class="[^"]*min-h-\[44px\][^"]*">Avery Example/.test(erased)).toBe(false);
  });
  it("the entry link centres its text in its tap target, and the answers follow it with the tight section gap", () => {
    const html = render([row()]);
    expect(html).toMatch(/class="[^"]*inline-flex[^"]*min-h-\[44px\][^"]*items-center[^"]*"[^>]*>Open this waitlist entry/);
    expect(html).toMatch(/<dl class="mt-1" data-testid="response-answers"/);
  });
});

describe("labels", () => {
  it("the owner reads exactly 'Why these times don't work' and 'Preferred availability'", () => {
    expect(OWNER_ANSWER_LABELS).toEqual({ why: "Why these times don't work", better: "Preferred availability" });
    const html = render([row()]);
    expect(html).toContain("Why these times don&#x27;t work");
    expect(html).toContain("Preferred availability");
    expect(html).not.toContain("Why don&#x27;t these times work?");
  });
  it("erased answers keep the erased wording and show no labels or answers", () => {
    const html = render([row({ answersErasedAt: "2026-11-01T00:00:00Z", whyNotWork: null, betterTimes: null })]);
    expect(html).toContain("Answers removed from view on Nov 1, 2026.");
    expect(html).not.toContain("Preferred availability");
    expect(html).not.toContain('data-testid="more-actions"');
  });
  it("a removed entry keeps the 'Removed from the waitlist.' wording", () => {
    expect(render([row({ status: "removed", closedAt: "2026-11-09T11:00:00Z" })])).toContain("Removed from the waitlist.");
  });
});

describe("Details", () => {
  it("is a native disclosure, collapsed by default, holding the delivery and retention lines", () => {
    const html = render([row()]);
    const d = /<details data-testid="response-details"([^>]*)>([\s\S]*?)<\/details>/.exec(html)!;
    expect(d[1]).not.toMatch(/\sopen/);
    expect(d[2]).toContain(">Details<");
    expect(d[2]).toContain("Answers will be removed from view on");
    expect(d[2]).toContain("Bell:");
  });
  it("retention and delivery lines appear ONLY inside Details", () => {
    const html = render([row()]);
    const outside = html.replace(/<details data-testid="response-details"[\s\S]*?<\/details>/, "");
    expect(outside).not.toContain("Answers will be removed from view on");
    expect(outside).not.toContain("Bell:");
  });
});

describe("actions: one primary, the rest secondary, none moved into a disclosure", () => {
  it("Book now is the only primary control; Mark handled is secondary", () => {
    const html = render([row()]);
    const primary = [...html.matchAll(/<(?:a|button)[^>]*class="([^"]*bg-accent[^"]*)"[^>]*>([^<]*)</g)].map((m) => m[2]);
    expect(primary).toEqual(["Book now"]);
    expect(html).toMatch(/<button[^>]*class="[^"]*border-line-strong[^"]*"[^>]*>Mark handled</);
  });
  it("the actions come after Details and keep their forms", () => {
    const html = render([row(), row({ followupId: "44444444-4444-4444-8444-444444444444", kind: "withdrawal", entryId: "e1" })]);
    expect(html).toContain("Mark handled");
    expect(html).toContain("Keep on the waitlist");
  });
});

describe("contact variants and the phone format", () => {
  it("long email wraps rather than overflows", () => {
    const html = render([row()], { kind: "entry", email: `${"a".repeat(70)}@${"b".repeat(40)}.example.test`, phone: null });
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain("min-w-0");
    expect(html).toContain("No phone number on this entry");
  });
  it("missing email, and a deleted entry, say so", () => {
    expect(render([row()], { kind: "entry", email: null, phone: "4165550123" })).toContain("No email on this entry");
    expect(render([row()], { kind: "gone" })).toContain("no longer exists");
  });
  it("formats a North American phone for reading and leaves the dialable digits alone", () => {
    expect(formatPhoneForDisplay("4165550123")).toBe("(416) 555-0123");
    expect(formatPhoneForDisplay("1-416-555-0123")).toBe("+1 (416) 555-0123");
    expect(formatPhoneForDisplay("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(formatPhoneForDisplay("ext 5 call after 6")).toBe("ext 5 call after 6");
    for (const raw of ["4165550123", "1-416-555-0123", "(416) 555-0123"]) expect(telHref(raw)).toBe(`tel:${raw.replace(/\D/g, "")}`);
    expect(render([row()])).toContain('href="tel:4165550123"');
  });
  it("opening or copying posts nothing: contact controls are links and buttons, never forms", () => {
    const html = render([row()]);
    const contact = /data-testid="reply-contact"[\s\S]*?(?=data-testid="response-answers")/.exec(html)![0];
    expect(contact).not.toContain("<form");
    expect(contact).not.toContain('type="submit"');
  });
});
