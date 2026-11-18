import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  who: vi.fn(),
  archived: vi.fn(),
  history: vi.fn(),
  contacts: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: h.who }));
vi.mock("@/lib/waitlist/entry-search", async (orig) => ({ ...(await orig<Record<string, unknown>>()), listArchivedEntries: h.archived }));
vi.mock("@/lib/waitlist/invitation-history-server", () => ({ loadInvitationHistory: h.history }));
vi.mock("@/lib/waitlist/reply-contact", () => ({ loadReplyContacts: h.contacts }));

import Page from "@/app/(app)/settings/waitlist/archived/page";
import { archivedFromRows } from "@/lib/waitlist/entry-search";
import { OPERATOR_QUEUE_STATUSES } from "@/lib/waitlist/operator-queue-presence";
import { ADMISSION_ACTIONS, actionAvailability } from "@/lib/waitlist/admission-model";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const E1 = "00000000-0000-4000-8000-0000000000e1";
const E2 = "00000000-0000-4000-8000-0000000000e2";
const E3 = "00000000-0000-4000-8000-0000000000e3";
const html = async () => renderToStaticMarkup((await Page()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  h.who.mockResolvedValue({ practitioner: { role: "owner", user_id: "u" }, studio: { id: "s1", timezone: "America/Toronto" } });
  h.archived.mockResolvedValue({
    kind: "ok",
    capped: false,
    entries: [
      { id: E1, name: "Avery Example", joinedAt: "2026-10-01T15:00:00Z", removedAt: "2026-11-05T15:00:00Z", removedByRecorded: true },
      { id: E2, name: "Avery Example", joinedAt: "2026-10-02T15:00:00Z", removedAt: "2026-11-06T15:00:00Z", removedByRecorded: true },
      { id: E3, name: "Pat Placeholder", joinedAt: "", removedAt: null, removedByRecorded: false },
    ],
  });
  h.history.mockResolvedValue({ kind: "ok", byEntry: new Map() });
  h.contacts.mockResolvedValue({
    kind: "ok",
    byEntry: new Map([
      [E1, { kind: "entry", email: "first@example.test", phone: null }],
      [E2, { kind: "entry", email: null, phone: "555 0102" }],
      [E3, { kind: "gone" }],
    ]),
  });
});

describe("the Archived view", () => {
  it("shows each removed person with their OWN contact, join and removal dates and 'reason not recorded'", async () => {
    const out = await html();
    const cards = out.split('data-testid="archived-entry"').slice(1);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain("first@example.test");
    expect(cards[0]).not.toContain("555 0102");
    expect(cards[0]).toContain("No phone number on this entry");
    expect(cards[1]).toContain("555 0102");
    expect(cards[1]).toContain("No email on this entry");
    expect(cards[0]).toContain("Removed on Nov 5, 2026 by an owner.");
    expect(cards[0]).toContain("Joined Oct 1, 2026.");
    expect(cards[0]).toContain("Reason not recorded.");
  });
  it("says plainly when dates are missing or the entry no longer exists, and guesses nothing", async () => {
    const card = (await html()).split('data-testid="archived-entry"')[3]!;
    expect(card).toContain("Join date not recorded.");
    expect(card).toContain("Removal date not recorded.");
    expect(card).toContain("no longer exists");
    expect(card).not.toContain("by an owner");
  });
  it("offers no form, button submit or action: no Return, no resolve, nothing sent", async () => {
    const out = await html();
    expect(out).not.toMatch(/<form|type="submit"|Return|Restore|Reinstate/);
  });
  it("a non-owner is refused before anything is read", async () => {
    h.who.mockResolvedValue({ practitioner: { role: "practitioner", user_id: "u" }, studio: { id: "s1" } });
    const out = await html();
    expect(out).toContain("Only studio owners");
    expect(h.archived).not.toHaveBeenCalled();
    expect(h.history).not.toHaveBeenCalled();
    expect(h.contacts).not.toHaveBeenCalled();
  });
  it("reads are scoped to the studio from the session and by entry id", async () => {
    await html();
    expect(h.archived).toHaveBeenCalledWith("s1");
    expect(h.contacts).toHaveBeenCalledWith("s1", [E1, E2, E3]);
    expect(h.history).toHaveBeenCalledWith("s1", [E1, E2, E3]);
  });
  it("promises nothing about how long anything is kept: the details are shown as recorded", async () => {
    const out = await html();
    expect(out).toContain("are shown here as recorded");
    expect(out).not.toMatch(/\bkept\b|\bretain|forever|permanent/i);
  });
  it("a failed read says so", async () => {
    h.archived.mockResolvedValue({ kind: "unknown" });
    expect(await html()).toContain("couldn’t load the archive");
  });
});

describe("Archived entries are not in the queue and cannot be invited", () => {
  it("the queue statuses exclude removed, so an archived entry is never counted or listed", () => {
    expect(OPERATOR_QUEUE_STATUSES).not.toContain("removed");
  });
  it("no admission action is available on a removed entry", () => {
    for (const a of ADMISSION_ACTIONS) expect(actionAvailability(a, "removed").available).toBe(false);
  });
  it("the database refuses to invite anything but a claimed entry, and removed has no way out", () => {
    const m = read("supabase/migrations/0189_waitlist_invitation_wall_clock_expiry.sql");
    expect(m).toContain("if v_status <> 'claimed' then");
    const g = read("supabase/migrations/0188_new_client_waitlist_invitations.sql");
    expect(g).not.toMatch(/\('removed',\s*'(waiting|claimed|invited|released|expired)'\)/);
  });
});

describe("archivedFromRows", () => {
  it("keeps same-name entries apart and drops malformed rows", () => {
    const out = archivedFromRows([
      { id: E1, name: "Avery Example", joined_at: "x", removed_at: "y", removed_by_practitioner_id: "p" },
      { id: E2, name: "Avery Example", joined_at: null, removed_at: null, removed_by_practitioner_id: null },
      { id: 7, name: "bad" },
    ]);
    expect(out.map((e) => [e.id, e.removedByRecorded])).toEqual([[E1, true], [E2, false]]);
  });
});
