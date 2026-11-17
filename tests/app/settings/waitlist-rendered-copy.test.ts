import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Rendered-text tests for the owner screens: each assertion is on the TEXT a person sees in a named screen state, from the real
// component. No assertion here compares a constant with itself or reads source text. Stores and senders are mocked; no database.

const h = vi.hoisted(() => ({ practitioner: vi.fn(), attention: vi.fn(), declined: vi.fn(), capacity: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async (orig) => ({ ...(await orig<Record<string, unknown>>()), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/queries", async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePractitionerWithStudio: h.practitioner }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/waitlist/needs-attention", async (orig) => ({ ...(await orig<Record<string, unknown>>()), loadNeedsAttention: h.attention }));
vi.mock("@/lib/waitlist/declined-attention", () => ({ loadDeclinedAttention: h.declined }));
vi.mock("@/app/(app)/settings/waitlist/window-capacity-actions", () => ({ estimateWindowCapacityAction: h.capacity }));
vi.mock("@/app/(app)/settings/waitlist/follow-up-actions", () => ({
  markHandledAction: vi.fn(),
  keepWithdrawalAction: vi.fn(),
  eraseAnswersAction: vi.fn(),
  linkAppointmentAction: vi.fn(),
}));

// A client whose every query resolves to an empty, error-free result, however it is chained.
// The studio has one bookable consultation service (the page needs one before it asks for an allowance); every other table is empty.
const SERVICE_ROWS = [{ id: "22222222-2222-4222-8222-222222222222", name: "Consultation", modality: "consultation", active: true }];
function queryFor(data: unknown[]): unknown {
  const result = { data, error: null, count: data.length };
  const node: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => unknown) => Promise.resolve(result).then(res) : node),
    apply: () => node,
  });
  return node;
}
const emptyClient = () => {
  const empty = queryFor([]);
  return { from: (table: string) => (table === "services" ? queryFor(SERVICE_ROWS) : empty), rpc: () => empty, auth: { admin: {} } };
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => emptyClient() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => emptyClient() }));

import WaitlistSettingsPage from "@/app/(app)/settings/waitlist/page";
import { DeclineEmailFailedNotice } from "@/components/waitlist/decline-email-failed-notice";
import { DeclineFollowUpSection } from "@/components/waitlist/decline-follow-up-section";
import { InviteComposerView } from "@/components/waitlist/invite-composer";
import { emptyOutboxCounts } from "@/lib/waitlist/decline-status-lines";
import { buildWaitlistDeclineOwnerEmail } from "@/lib/email/templates/waitlist-decline-owner";
import { emptyDraft, initialComposerState, type InviteDraft } from "@/lib/waitlist/b4-invitation-draft";
import { capacityLines } from "@/lib/waitlist/consultation-capacity";
import type { FollowUpRow } from "@/lib/waitlist/followups-owner";

/** What a person reads: tags gone, entities decoded to the characters on screen, whitespace collapsed. */
const readable = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&hellip;|&#8230;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const STUDIO = { id: "11111111-1111-4111-8111-111111111111", timezone: "UTC", slug: "synthetic" };

async function ownerPage(): Promise<string> {
  h.practitioner.mockResolvedValue({ practitioner: { id: "p1", role: "owner", user_id: "u1" }, studio: STUDIO });
  return readable(renderToStaticMarkup(await WaitlistSettingsPage({ searchParams: Promise.resolve({}) })));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.attention.mockResolvedValue({ kind: "ok", total: 0, shown: [] });
  h.declined.mockResolvedValue({ kind: "ok", total: 0, shown: [], ids: new Set() });
  h.capacity.mockResolvedValue({ ok: false });
});

describe("the owner's Waitlist page: the allowance", () => {
  it("shows the headline and the 14-day note when the estimate is known (window scope)", async () => {
    h.capacity.mockResolvedValue({ ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" });
    const page = await ownerPage();
    expect(page).toContain("5 consultation appointments available. You can invite 3 more people.");
    expect(page).toContain(
      "Next 14 days, any day or time. These are minimums: the count never over-promises but may under-count. Availability can change; invitations don’t reserve appointments.",
    );
  });
  it("says the counts include every live invitation when the estimate is the conservative one (all scope)", async () => {
    h.capacity.mockResolvedValue({ ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "all" });
    const page = await ownerPage();
    expect(page).toContain("These are minimums, and the invitations already out are counted whatever dates they cover.");
  });
  it("uses the singular for one appointment and one person", async () => {
    h.capacity.mockResolvedValue({ ok: true, fit: 1, outstanding: 0, open: 1, outstandingScope: "window" });
    expect(await ownerPage()).toContain("1 consultation appointment available. You can invite 1 more person.");
  });
  it("says it could not check, and to reload, when the estimate is unavailable", async () => {
    h.capacity.mockResolvedValue({ ok: false });
    const page = await ownerPage();
    expect(page).not.toContain("consultation appointments available");
    expect(page).toContain(
      "We couldn’t check availability just now. Reload the page to see how many people you can invite. Availability can change; invitations don’t reserve appointments.",
    );
  });
});

describe("the owner's Waitlist page: the two amber cards", () => {
  it("shows neither card when nothing needs attention and nobody declined", async () => {
    const page = await ownerPage();
    expect(page).not.toContain("Needs your attention");
    expect(page).not.toContain("Declined the offered times");
  });
  it("tells the owner, for one person whose booking did not complete, what happened and what to do", async () => {
    h.attention.mockResolvedValue({ kind: "ok", total: 1, shown: [{ id: "e1", name: "Synthetic Person" }] });
    const page = await ownerPage();
    expect(page).toContain("Needs your attention (1)");
    expect(page).toContain(
      "The booking didn’t complete for this person. Their invitation has been used, so it can’t be sent again. Please check the calendar, then contact them to book a time.",
    );
  });
  it("uses the plural for several people", async () => {
    h.attention.mockResolvedValue({ kind: "ok", total: 2, shown: [{ id: "e1", name: "A" }, { id: "e2", name: "B" }] });
    expect(await ownerPage()).toContain("The booking didn’t complete for these people.");
  });
  it("tells the owner, for one person who declined every offered time, that they are off the list and nobody has been told", async () => {
    h.declined.mockResolvedValue({ kind: "ok", total: 1, shown: [{ id: "e2", name: "Synthetic Two" }], ids: new Set(["e2"]) });
    const page = await ownerPage();
    expect(page).toContain("Declined the offered times (1)");
    expect(page).toContain("This person said none of the offered times suit them. They are off the waitlist for now and nobody has been told.");
    expect(page).toContain("Return them to the waitlist to restore their original place.");
  });
  it("uses the plural for several people who declined", async () => {
    h.declined.mockResolvedValue({ kind: "ok", total: 2, shown: [{ id: "e2", name: "A" }, { id: "e3", name: "B" }], ids: new Set(["e2", "e3"]) });
    expect(await ownerPage()).toContain("These people said none of the offered times suit them. Each is off the waitlist for now and nobody has been told.");
  });
});

describe("the failed-email notice", () => {
  const text = (props: { failed: number; atLeast?: boolean }) => readable(renderToStaticMarkup(createElement(DeclineEmailFailedNotice, props)));
  it("names one email, and that the responses are still listed", () => {
    expect(text({ failed: 1 })).toBe("An email about a waitlist response could not be delivered. The responses are still listed here.");
  });
  it("gives a count for several, and a lower bound when the count is capped", () => {
    expect(text({ failed: 3 })).toBe("3 emails about waitlist responses could not be delivered. The responses are still listed here.");
    expect(text({ failed: 500, atLeast: true })).toBe("500+ emails about waitlist responses could not be delivered. The responses are still listed here.");
  });
  it("shows nothing when nothing failed", () => {
    expect(text({ failed: 0 })).toBe("");
  });
});

describe("the owner's follow-up rows: Keep on the waitlist", () => {
  const row = (o: Partial<FollowUpRow> = {}): FollowUpRow => ({
    followupId: "33333333-3333-4333-8333-333333333333",
    kind: "withdrawal",
    invitationId: "i1",
    entryId: "e1",
    clientName: "Synthetic Person",
    openedAt: "2026-11-09T10:00:00Z",
    status: "open",
    whyNotWork: null,
    betterTimes: null,
    answersErasedAt: null,
    submittedAt: "2026-11-09T10:00:00Z",
    closedAt: null,
    eraseBy: "2027-02-07T10:00:00Z",
    ...o,
  });
  const section = (rows: FollowUpRow[]) =>
    readable(
      renderToStaticMarkup(
        createElement(DeclineFollowUpSection, { rows, timeZone: "UTC", emailEnabled: true, outbox: new Map([["i1", emptyOutboxCounts()]]), linkable: new Map(), notice: null }),
      ),
    );
  it("offers the button, and does not yet say it was kept, while the withdrawal is open", () => {
    const page = section([row({ status: "open" })]);
    expect(page).toContain("Keep on the waitlist");
    expect(page).not.toContain("Kept on the waitlist.");
  });
  it("says Kept on the waitlist. once the row is kept, and no longer offers the button", () => {
    const page = section([row({ status: "kept", closedAt: "2026-11-09T11:00:00Z" })]);
    expect(page).toContain("Kept on the waitlist.");
    expect(page).not.toContain("Keep on the waitlist");
  });
  it("says there is nothing to follow up when there are no rows", () => {
    expect(section([])).toContain("No responses need follow-up.");
  });
});

describe("the owner email, as rendered", () => {
  const mail = buildWaitlistDeclineOwnerEmail({ appOrigin: "https://app.example.test/" });
  it("says the one approved sentence in the text and html bodies, with the button and the sign-in link, and names no one", () => {
    expect(mail.subject).toBe("A waitlist response needs your attention");
    for (const body of [mail.text, readable(mail.html)]) {
      expect(body).toContain("Someone responded to your consultation invitation. Sign in to review their response and follow up.");
      expect(body).toContain("Review response");
    }
    // The link is an attribute in the html and a line in the text.
    expect(mail.text).toContain("https://app.example.test/settings/waitlist?followup=1#follow-up");
    expect(mail.html).toContain('href="https://app.example.test/settings/waitlist?followup=1#follow-up"');
    expect(readable(mail.html)).not.toMatch(/Synthetic|@|\d{3}[-. ]?\d{4}/);
    // Privacy: no answer text and no test-fixture wording in either body, raw or rendered (the template takes no answer input at all).
    for (const body of [mail.text, mail.html, readable(mail.html)]) expect(body).not.toMatch(/Synthetic|mornings/);
  });
});

describe("the invite composer's capacity note, in each state", () => {
  const draft: InviteDraft = { ...emptyDraft(), serviceId: "svc-1" };
  const composer = (capacity: Parameters<typeof InviteComposerView>[0]["capacity"]) =>
    readable(
      renderToStaticMarkup(
        createElement(InviteComposerView, {
          entryId: "entry-1",
          entryName: "Synthetic",
          draft,
          services: [{ id: "svc-1", name: "Consultation", modality: "consultation" }],
          capabilities: null,
          action: null,
          state: initialComposerState(draft),
          dispatch: () => {},
          capacity,
        }),
      ),
    );
  it("says Checking availability… while it checks, and no figure", () => {
    const page = composer({ status: "loading" });
    expect(page).toContain("Checking availability…");
    expect(page).not.toContain("consultation appointment");
  });
  it("says it could not check, and that nothing is reserved, when the check fails", () => {
    expect(composer({ status: "unavailable" })).toContain("We couldn’t check availability just now. Nothing is reserved.");
  });
  it("shows the headline, the invitations already out and the reservation note when the estimate is known", () => {
    const page = composer({ status: "ok", lines: capacityLines({ fit: 5, outstanding: 2, open: 3 }) });
    expect(page).toContain("5 consultation appointments available. You can invite 3 more people.");
    expect(page).toContain("2 invitations are already out for these dates and not yet booked, so about 3 more could be offered.");
    expect(page).toContain("Availability can change at any time. Nothing is reserved for an invitation until the person books.");
  });
  it("shows nothing about availability before a window is chosen", () => {
    const page = composer({ status: "idle" });
    expect(page).not.toContain("Checking availability");
    expect(page).not.toContain("Nothing is reserved");
  });
});
