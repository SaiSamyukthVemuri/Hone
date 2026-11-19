import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortalMessagesCard } from "@/components/portal-messages-card";
import { PORTAL_MESSAGES_OFF_NOTE } from "@/lib/booking/client-self-service-policy";

// HON-47 (Sam's decision): with client portal access off, the staff "New message" action is HIDDEN with a short note.
// Rendered through react-dom/server (output, not a source grep). The server refusal is
// tests/app/clients/portal-message-portal-off.test.ts. Synthetic data only.

const base = {
  clientId: "c1",
  clientName: "Client One",
  clientHasEmail: true,
  clientIsArchived: false,
  messages: [],
  replies: [],
  createAction: async () => ({ ok: false as const, error: "x" }),
  archiveAction: async () => ({ ok: true as const }),
  markReplySeenAction: async () => undefined,
  practitionerNames: {},
};
const html = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PortalMessagesCard, { ...base, ...extra } as never));

describe("PortalMessagesCard when the client portal is off", () => {
  it("DEFAULT (prop absent): the composer button is offered and there is no off note", () => {
    const out = html();
    expect(out).toContain("+ New message");
    expect(out).not.toContain("portal-messages-off-status");
  });
  it("portalEnabled true: same as default", () => {
    expect(html({ portalEnabled: true })).toContain("+ New message");
  });
  it("portal off: the New message action is hidden and the note says why", () => {
    const out = html({ portalEnabled: false });
    expect(out).not.toContain("+ New message");
    expect(out).toContain("portal-messages-off-status");
    expect(out).toContain("Client portal is off for this studio");
    expect(out).toContain(PORTAL_MESSAGES_OFF_NOTE.replace(/'/g, "&#x27;"));
  });
  it("an archived client keeps its own explanation, not the portal note", () => {
    const out = html({ portalEnabled: false, clientIsArchived: true });
    expect(out).toContain("Archived clients cannot receive portal messages.");
    expect(out).not.toContain("portal-messages-off-status");
  });
});
