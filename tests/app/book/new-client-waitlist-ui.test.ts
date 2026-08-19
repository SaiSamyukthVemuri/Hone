import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ===========================================================================
// THE RENDERED PUBLIC BOOKING SURFACE, FLAG OFF AND FLAG ON
// ===========================================================================
//
// Renders the REAL PublicBookForm through react-dom/server and asserts on its
// OUTPUT, not its source. The load-bearing property is flag-OFF: the surface
// must be INDISTINGUISHABLE from current production, so it is written as a
// byte-for-byte comparison against the markup produced with the prop omitted
// entirely — which is what every pre-existing call site does.

vi.mock("@/app/book/[slug]/actions", () => ({
  fetchNextAvailableDateAction: async () => ({ ok: true, date: null }),
  fetchPublicSlotsAction: async () => ({ ok: true, slots: [] }),
  publicBookAppointmentAction: async () => ({ ok: false, error: "not used" }),
}));
vi.mock("@/app/book/[slug]/waitlist-actions", () => ({
  submitNewClientBookingWaitlistAction: async () => ({ ok: true }),
}));

const { PublicBookForm } = await import("@/app/book/[slug]/PublicBookForm");
const { NewClientWaitlistForm } = await import("@/app/book/[slug]/NewClientWaitlistForm");

const SERVICES = [
  { id: "svc-consult", studio_id: "studio-1", name: "New Client Consultation", modality: "consultation", default_duration_minutes: 45, price_cents: 0, active: true, sort_order: 0 },
  { id: "svc-treatment", studio_id: "studio-1", name: "Electrolysis Treatment", modality: "electrolysis", default_duration_minutes: 60, price_cents: 0, active: true, sort_order: 1 },
] as unknown as Parameters<typeof PublicBookForm>[0]["services"];

function renderForm(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(PublicBookForm, {
      slug: "willow-electrolysis",
      studioName: "Willow Electrolysis",
      studioAddress: null,
      services: SERVICES,
      defaultDate: "2026-09-01",
      minDate: "2026-08-19",
      maxDate: "2026-10-19",
      ...overrides,
    } as Parameters<typeof PublicBookForm>[0]),
  );
}

const waitlistHtml = () =>
  renderToStaticMarkup(
    createElement(NewClientWaitlistForm, {
      slug: "willow-electrolysis",
      studioName: "Willow Electrolysis",
      onContinueAsExistingClient: () => {},
    }),
  );

describe("flag OFF — the public booking surface is unchanged", () => {
  it("is byte-identical with the prop omitted, false, and undefined", () => {
    const baseline = renderForm();
    expect(renderForm({ newClientWaitlistEnabled: false })).toBe(baseline);
    expect(renderForm({ newClientWaitlistEnabled: undefined })).toBe(baseline);
  });

  it("still offers the existing new/existing choice, with no waitlist copy anywhere", () => {
    const html = renderForm({ newClientWaitlistEnabled: false });
    expect(html).toContain("Are you new to Willow Electrolysis?");
    expect(html).toContain("I’m a new client");
    expect(html).toContain("I’m an existing client");
    expect(html.toLowerCase()).not.toContain("waitlist");
  });

  it("turning the flag ON does not change the first step either", () => {
    // The chooser is where BOTH client types land. Turning the flag on must
    // not alter it, or an existing client would meet waitlist framing before
    // identifying themselves.
    const off = renderForm({ newClientWaitlistEnabled: false });
    const on = renderForm({ newClientWaitlistEnabled: true });
    expect(on).toBe(off);
    expect(on.toLowerCase()).not.toContain("waitlist");
  });

  // NOTE ON SCOPE. Choosing a client type is browser state a static render
  // cannot drive, so "flag ON + existing client keeps the normal booking UI"
  // is proven where it can be: end to end in e2e/new-client-waitlist.spec.ts,
  // and on the server in tests/app/book/new-client-waitlist-gate.test.ts,
  // which drives the real booking action with client_type=existing against a
  // waitlisted studio and shows the gate does not intercept it.
});

describe("flag ON — the new-client surface", () => {
  it("is the waitlist form, with no service / date / slot picker", () => {
    const html = waitlistHtml();
    expect(html).toContain("Join the new-client waitlist");
    expect(html).toContain("Willow Electrolysis is currently booking new clients from a waitlist");
    expect(html).toContain("Joining the waitlist does not reserve an appointment.");
    expect(html).toContain("Join waitlist");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain("Book appointment");
  });

  it("keeps an explicit existing-client escape and never claims the studio is full", () => {
    const html = waitlistHtml();
    expect(html).toContain("Already a client? Continue booking.");
    for (const forbidden of ["fully booked", "no appointments available", "we’re full"]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("exposes no capacity, utilization, queue or workload information", () => {
    const html = waitlistHtml().toLowerCase();
    for (const forbidden of [
      "utilization", "utilisation", "capacity", "queue", "position",
      "conversion", "%", "critical",
    ]) {
      expect(html, `must not expose "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe("mobile / accessibility contract of the waitlist form", () => {
  const html = waitlistHtml();

  it("associates every label with its input", () => {
    const forIds = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
    const inputIds = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(forIds).toHaveLength(3);
    for (const id of forIds) expect(inputIds).toContain(id);
  });

  it("uses the right mobile keyboard and autofill hints", () => {
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).toContain('inputMode="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('inputMode="tel"');
    expect(html).toContain('autoComplete="tel"');
    expect(html).toContain('autoComplete="name"');
  });

  it("gives the CTA a >=44px target and bounds every field to the container", () => {
    expect(html).toContain("min-h-[44px]");
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input, "fields must not overflow at 390px").toContain("w-full");
      expect(input).toContain("max-w-full");
    }
  });

  it("submits through a real form element, so keyboard Enter works", () => {
    expect(html).toContain("<form");
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });
});
