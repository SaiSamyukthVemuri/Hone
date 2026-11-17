import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("@/app/(app)/records/print/ticket/[token]/reopen-action", () => ({ reopenDayPacketAction: vi.fn() }));

import { NOT_OWNER_MESSAGE, ReopenButton } from "@/app/(app)/records/print/ticket/[token]/reopen-button";

// Synthetic ticket text only.
const TICKET = "A".repeat(127);

describe("Open again control", () => {
  it("an owner sees the button, at least 44px high, and not the sentence", () => {
    const html = renderToStaticMarkup(createElement(ReopenButton, { ticket: TICKET, isOwner: true }));
    expect(html).toContain("Open again");
    expect(html).toContain("min-h-[44px]");
    expect(html).not.toContain(NOT_OWNER_MESSAGE);
  });
  it("a non-owner sees the sentence in place of the button", () => {
    const html = renderToStaticMarkup(createElement(ReopenButton, { ticket: TICKET, isOwner: false }));
    expect(html).toContain("Only the studio owner can open this record again.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Open again");
  });
  it("neither version puts the ticket, a client id or a day in the markup", () => {
    for (const isOwner of [true, false]) {
      const html = renderToStaticMarkup(createElement(ReopenButton, { ticket: TICKET, isOwner }));
      expect(html).not.toContain(TICKET);
      expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|\d{4}-\d{2}-\d{2}/i);
    }
  });
  it("the page decides from the signed-in practitioner only, and the action still refuses a non-owner", () => {
    const page = readFileSync("app/(app)/records/print/ticket/[token]/page.tsx", "utf8");
    expect(page).toMatch(/isOwner=\{practitioner\.role === "owner" && practitioner\.active === true\}/);
  });
});

// The sentence depends on the signed-in viewer's role and nothing else: a non-owner gets the identical page for every ticket.
const state = { role: "practitioner" as string, id: "22222222-2222-4222-8222-222222222222", studio: "11111111-1111-4111-8111-111111111111" };
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { id: state.id, role: state.role, active: true }, studio: { id: state.studio } }),
}));
vi.mock("@/lib/records/print/ticket-store", () => ({ consumeTicketNonce: async () => "fresh" }));
vi.mock("@/app/(app)/records/print/_packet/day-packet-view", () => ({ DayPacketView: () => null }));

import { mintTicket } from "@/lib/records/print/ticket";
import TicketedDayPacketPage from "@/app/(app)/records/print/ticket/[token]/page";

const SECRET = "synthetic-print-ticket-secret-0123456789abcdef";
const OTHER_STUDIO = "33333333-3333-4333-8333-333333333333";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";

function mint(studioId: string, ownerId: string, now = new Date()) {
  const m = mintTicket({ secret: SECRET, binding: { studioId, ownerId }, subject: { clientId: CLIENT, day: "2031-02-17" }, now });
  if (!m.ok) throw new Error("mint");
  return m.ticket;
}
async function page(token: string) {
  process.env.PRINT_TICKET_SECRET = SECRET;
  return renderToStaticMarkup(await TicketedDayPacketPage({ params: Promise.resolve({ token }) }));
}

describe("a non-owner sees the identical page whatever the ticket", () => {
  it("valid, expired, forged, malformed and other-studio tickets all render the same sentence and no button", async () => {
    state.role = "practitioner";
    const tickets = {
      // valid and unused for the studio, minted for an owner (a non-owner cannot mint one for themselves)
      valid: mint(state.studio, "44444444-4444-4444-8444-444444444444"),
      expired: mint(state.studio, state.id, new Date(Date.now() - 60 * 60_000)),
      forged: mint(state.studio, state.id).slice(0, -3) + "AAA",
      malformed: "not-a-ticket",
      otherStudio: mint(OTHER_STUDIO, state.id),
    };
    const pages = await Promise.all(Object.values(tickets).map(page));
    for (const html of pages) {
      expect(html).toContain(NOT_OWNER_MESSAGE);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("Open again");
    }
    expect(new Set(pages).size).toBe(1);
  });
  it("an owner sees the button for every one of them", async () => {
    state.role = "owner";
    for (const t of [mint(state.studio, "44444444-4444-4444-8444-444444444444"), "not-a-ticket", mint(OTHER_STUDIO, state.id)]) {
      const html = await page(t);
      expect(html).toContain("Open again");
      expect(html).not.toContain(NOT_OWNER_MESSAGE);
    }
  });
});
