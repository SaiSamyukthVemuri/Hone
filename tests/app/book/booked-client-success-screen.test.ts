// HON-50 (Sam, 24 Oct, decision C). The booking-success screen shows ONLY the
// address the server verified for this booking (the action's
// bookedClientAddress, tests/lib/booking/booked-client-address.test.ts), or
// what the public page already shows. Nothing a visitor can put in the URL or
// the client state reaches it. All values are synthetic.

import { describe, expect, it, vi } from "vitest";

// The form module's server actions are irrelevant to the screen.
vi.mock("@/app/book/[slug]/actions", () => ({}));
vi.mock("@/app/book/[slug]/waitlist-actions", () => ({}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { ConfirmationView } = await import("@/app/book/[slug]/PublicBookForm");

const PRIVATE = "100 Synthetic Private Lane, Toronto ON";
const PUBLIC = "200 Synthetic Public Street, Toronto ON";

function screen(opts: { verified: string | null; publicAddress: string | null }): string {
  return renderToStaticMarkup(
    createElement(ConfirmationView, {
      confirmation: {
        when: "2:00 PM",
        dateLocal: "2031-03-04",
        service: null,
        email: "client@synthetic.test",
        manageUrl: "https://hone.care/manage/tok_SYNTH",
        emailStatus: "sent",
        bookedClientAddress: opts.verified,
      },
      studioName: "Synthetic Studio",
      studioAddress: opts.publicAddress,
      studioSlug: "synthetic",
    } as never),
  );
}

describe("success screen address", () => {
  it("booked-client-only studio, verified booking: shows the verified address", () => {
    expect(screen({ verified: PRIVATE, publicAddress: null })).toContain(PRIVATE);
  });

  it("booked-client-only studio, verification answered null (unauthorized, wrong studio, not confirmed): no address", () => {
    const html = screen({ verified: null, publicAddress: null });
    expect(html).not.toContain(PRIVATE);
    expect(html).not.toContain("Synthetic Private Lane");
  });

  it("public studio: shows the public address, as today", () => {
    expect(screen({ verified: null, publicAddress: PUBLIC })).toContain(PUBLIC);
  });

  it("the screen reads no URL or search params of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/book/[slug]/PublicBookForm.tsx", "utf8");
    expect(src).not.toMatch(/useSearchParams|window\.location|searchParams/);
  });
});
