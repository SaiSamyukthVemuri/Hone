import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ===========================================================================
// B / C — the rendered public booking surface, with the flag OFF and ON.
// ===========================================================================
//
// Renders the REAL PublicBookForm through react-dom/server and asserts on its
// OUTPUT, not on its source. The component is a client component, so the
// server actions it imports are stubbed; nothing here performs I/O.
//
// The load-bearing property is B: with the flag off the surface must be
// INDISTINGUISHABLE from current production. So the flag-off assertions are
// written as a byte-for-byte comparison against the markup produced with the
// prop omitted entirely (which is what every pre-existing call site does).

vi.mock("@/app/book/[slug]/actions", () => ({
  fetchNextAvailableDateAction: async () => ({ ok: true, date: null }),
  fetchPublicSlotsAction: async () => ({ ok: true, slots: [] }),
  publicBookAppointmentAction: async () => ({ ok: false, error: "not used" }),
}));
vi.mock("@/app/book/[slug]/waitlist-actions", () => ({
  submitNewClientBookingWaitlistAction: async () => ({ ok: true }),
}));

const { PublicBookForm } = await import("@/app/book/[slug]/PublicBookForm");
const { NewClientWaitlistForm } = await import(
  "@/app/book/[slug]/NewClientWaitlistForm"
);

const SERVICES = [
  {
    id: "svc-consult",
    studio_id: "studio-1",
    name: "New Client Consultation",
    modality: "consultation",
    default_duration_minutes: 45,
    price_cents: 0,
    active: true,
    sort_order: 0,
  },
  {
    id: "svc-treatment",
    studio_id: "studio-1",
    name: "Electrolysis Treatment",
    modality: "electrolysis",
    default_duration_minutes: 60,
    price_cents: 0,
    active: true,
    sort_order: 1,
  },
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

const WAITLIST_MARKERS = [
  "Join the new-client waitlist",
  "booking new clients from a waitlist",
  "does not reserve an appointment",
];

describe("B. flag OFF — the public booking surface is unchanged", () => {
  it("the first step is byte-identical with the prop omitted, false, and undefined", () => {
    const baseline = renderForm();
    expect(renderForm({ newClientWaitlistEnabled: false })).toBe(baseline);
    expect(renderForm({ newClientWaitlistEnabled: undefined })).toBe(baseline);
  });

  it("the first step still offers the existing new/existing choice and no waitlist copy", () => {
    const html = renderForm({ newClientWaitlistEnabled: false });
    expect(html).toContain("Are you new to Willow Electrolysis?");
    expect(html).toContain("I’m a new client");
    expect(html).toContain("I’m an existing client");
    for (const marker of WAITLIST_MARKERS) {
      expect(html, `flag-off must not render "${marker}"`).not.toContain(marker);
    }
  });

  it("renders no waitlist copy anywhere in the flag-off markup", () => {
    expect(renderForm().toLowerCase()).not.toContain("waitlist");
  });
});

// The rendered first step is the ClientTypeChooser, and picking a type is
// browser state that a static render cannot drive. The branch a chosen type
// produces is therefore proven at its two ends: the waitlist component's own
// output (below) and the untouched existing-client path.
describe("C. flag ON — new client sees the waitlist, existing client does not", () => {
  it("the NEW-client surface is the waitlist form, with no service / date / slot picker", () => {
    const html = renderToStaticMarkup(
      createElement(NewClientWaitlistForm, {
        slug: "willow-electrolysis",
        studioName: "Willow Electrolysis",
        onContinueAsExistingClient: () => {},
      }),
    );

    expect(html).toContain("Join the new-client waitlist");
    expect(html).toContain(
      "Willow Electrolysis is currently booking new clients from a waitlist",
    );
    expect(html).toContain("Joining the waitlist does not reserve an appointment.");
    expect(html).toContain("Join waitlist");

    // No booking machinery reached this surface.
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain("Book appointment");
  });

  it("the waitlist surface keeps an explicit existing-client escape and never claims the studio is full", () => {
    const html = renderToStaticMarkup(
      createElement(NewClientWaitlistForm, {
        slug: "willow-electrolysis",
        studioName: "Willow Electrolysis",
        onContinueAsExistingClient: () => {},
      }),
    );
    expect(html).toContain("Already a client? Continue booking.");
    // These would be FALSE for existing clients, who are still booking.
    for (const forbidden of [
      "fully booked",
      "No appointments available",
      "we’re full",
    ]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("exposes no capacity, utilization, queue or workload information", () => {
    const html = renderToStaticMarkup(
      createElement(NewClientWaitlistForm, {
        slug: "willow-electrolysis",
        studioName: "Willow Electrolysis",
        onContinueAsExistingClient: () => {},
      }),
    ).toLowerCase();
    for (const forbidden of [
      "utilization",
      "utilisation",
      "capacity",
      "queue",
      "position",
      "conversion",
      "%",
      "critical",
    ]) {
      expect(html, `must not expose "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("turning the flag ON does not change the first step either", () => {
    // The chooser is what BOTH client types land on. Turning the flag on must
    // not alter it, otherwise an existing client would meet waitlist framing
    // before they ever identify themselves.
    const off = renderForm({ newClientWaitlistEnabled: false });
    const on = renderForm({ newClientWaitlistEnabled: true });
    expect(on).toBe(off);
    expect(on.toLowerCase()).not.toContain("waitlist");
  });

  // NOTE on scope. Choosing a client type is browser state that a static
  // render cannot drive, so "flag ON + existing client keeps the normal
  // booking UI" is proven where it can be: end to end in
  // e2e/new-client-waitlist.spec.ts, and on the server in
  // tests/app/book/new-client-waitlist-gate.test.ts, which drives the real
  // booking action with client_type=existing under a waitlisted studio and
  // shows the gate does not intercept it.
});

describe("mobile / accessibility contract of the waitlist form", () => {
  const html = renderToStaticMarkup(
    createElement(NewClientWaitlistForm, {
      slug: "willow-electrolysis",
      studioName: "Willow Electrolysis",
      onContinueAsExistingClient: () => {},
    }),
  );

  it("associates every label with its input", () => {
    const forIds = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
    const inputIds = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(forIds).toHaveLength(3);
    for (const id of forIds) expect(inputIds).toContain(id);
  });

  it("uses the right mobile keyboard and autofill hints", () => {
    expect(html).toMatch(/<input[^>]*type="email"[^>]*/);
    expect(html).toContain('inputMode="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('inputMode="tel"');
    expect(html).toContain('autoComplete="tel"');
    expect(html).toContain('autoComplete="name"');
  });

  it("gives the CTA a >=44px touch target and bounds every field to the container", () => {
    expect(html).toContain("min-h-[44px]");
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input, "fields must not overflow at 390px").toContain("w-full");
      expect(input).toContain("max-w-full");
    }
  });

  it("submits through a real form element, so the keyboard Enter key works", () => {
    expect(html).toContain("<form");
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });
});
