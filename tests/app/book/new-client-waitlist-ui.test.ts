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
  submitNewClientBookingWaitlistAction: async () => ({ ok: true as const }),
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
    const fields = inputs.filter((input) => !input.includes('type="radio"'));
    expect(fields).toHaveLength(3);
    for (const input of fields) {
      expect(input, "fields must not overflow at 390px").toContain("w-full");
      expect(input).toContain("max-w-full");
    }
  });

  it("0208: each SMS answer is a >=44px target, labelled by its own word", () => {
    // The radio itself is small; the LABEL is the target, so it carries the
    // height. Each label wraps exactly one radio and names it.
    // Labels do not nest, so each match runs to its own closing tag.
    const labels = [...html.matchAll(/<label[^>]*>[\s\S]*?<\/label>/g)]
      .map((m) => m[0])
      .filter((label) => label.includes('type="radio"'));
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label).toContain("min-h-[44px]");
      expect(label.match(/<input/g)).toHaveLength(1);
    }
    expect(labels[0]).toMatch(/>Yes<\/label>$/);
    expect(labels[1]).toMatch(/>No<\/label>$/);
  });

  it("submits through a real form element, so keyboard Enter works", () => {
    expect(html).toContain("<form");
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });
});

// ===========================================================================
// SMS-04 — THE APPROVED SIGNUP: A REQUIRED PHONE AND THE VERSION-2 QUESTION
// ===========================================================================
describe("SMS-04: the phone number is required and the text question is version 2", () => {
  const html = waitlistHtml();
  const phoneInput = () => {
    const m = html.match(/<input[^>]*name="phone"[^>]*>/);
    expect(m, "the phone input renders").not.toBeNull();
    return m![0];
  };

  it("labels the field exactly 'Phone number' with the same required marker as Name and Email", () => {
    expect(html).toContain('Phone number <span aria-hidden="true">*</span>');
    expect(html).toContain('Name <span aria-hidden="true">*</span>');
    expect(html).toContain('Email <span aria-hidden="true">*</span>');
    expect(html).not.toContain("Phone (optional)");
  });

  it("marks the phone input required, for assistive technology too", () => {
    const input = phoneInput();
    expect(input).toMatch(/\srequired=""/);
    expect(input).toContain('aria-required="true"');
    expect(input).toContain('type="tel"');
    expect(input).toContain('autoComplete="tel"');
  });

  it("shows the approved help text, tied to the field", async () => {
    const { WAITLIST_PHONE_HELP } = await import("@/lib/waitlist/signup-contact");
    expect(WAITLIST_PHONE_HELP).toBe(
      "A phone number is required so we can contact you. Please check that this is your own number.",
    );
    expect(html).toContain(WAITLIST_PHONE_HELP);
    const describedBy = phoneInput().match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>${WAITLIST_PHONE_HELP}</p>`));
  });

  it("asks the approved version-2 question verbatim, and no longer the v1 sentence", async () => {
    const consent = await import("@/lib/waitlist/prospect-sms-consent");
    expect(consent.SMS_JOIN_CONSENT_QUESTION).toBe(
      "May we text you about joining this waitlist and any appointment offered from it? Reply STOP at any time to opt out.",
    );
    expect(consent.SMS_JOIN_CONSENT_TEXT_VERSION).toBe("waitlist_sms_operational_v2");
    expect(html).toContain(consent.SMS_JOIN_CONSENT_QUESTION);
    expect(html).not.toContain(consent.SMS_OPERATIONAL_CONSENT_LABEL);
  });

  it("keeps v1 on record: its sentence is unchanged and still resolvable by version", async () => {
    const consent = await import("@/lib/waitlist/prospect-sms-consent");
    expect(consent.SMS_OPERATIONAL_CONSENT_TEXT_VERSION).toBe("waitlist_sms_operational_v1");
    expect(consent.SMS_CONSENT_WORDING_BY_VERSION).toEqual({
      waitlist_sms_operational_v1:
        "Text me about this waitlist and any appointment offered from it. Reply STOP at any time to opt out.",
      waitlist_sms_operational_v2:
        "May we text you about joining this waitlist and any appointment offered from it? Reply STOP at any time to opt out.",
    });
  });

  it("keeps the Yes/No question mandatory with NEITHER answer preselected", () => {
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).not.toMatch(/\schecked(=|\s|>)/);
    expect(html).toContain('Text messages <span aria-hidden="true">*</span>');
  });

  it("gives EVERY control a visible keyboard focus ring (the booking page's own)", () => {
    const ring = "focus-visible:ring-2";
    const controls = [
      ...html.matchAll(/<(input|button|a)\b[^>]*>/g),
    ].map((m) => m[0]);
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const c of controls) {
      expect(c, `missing focus ring: ${c.slice(0, 80)}`).toContain(ring);
      expect(c).toContain("focus-visible:ring-[#0A0A0A]");
    }
  });

  it("names nobody's place, capacity or queue in the new copy", async () => {
    const { WAITLIST_PHONE_HELP, WAITLIST_PHONE_REQUIRED, WAITLIST_PHONE_INVALID } = await import(
      "@/lib/waitlist/signup-contact"
    );
    for (const copy of [WAITLIST_PHONE_HELP, WAITLIST_PHONE_REQUIRED, WAITLIST_PHONE_INVALID]) {
      expect(copy).not.toMatch(/full|capacity|queue|position|already|verify|code/i);
    }
  });
});
