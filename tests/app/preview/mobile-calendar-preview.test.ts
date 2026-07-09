import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Preview-only mobile-calendar harness (PR #380 phone testing). Safety pins: it
// must 404 in production, use NO auth/DB/real data, run no server actions, and
// only be publicly reachable because it is fake-data + prod-gated.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/preview/mobile-calendar/page.tsx");
const SHELL = read("app/preview/mobile-calendar/MobilePreviewShell.tsx");
const MW = read("lib/supabase/middleware.ts");

describe("preview route is safe (prod-gated, auth-free, fake data)", () => {
  it("404s in production", () => {
    expect(PAGE).toMatch(/process\.env\.VERCEL_ENV === "production"/);
    expect(PAGE).toMatch(/notFound\(\)/);
  });
  it("is noindex", () => {
    expect(PAGE).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
  it("uses NO auth / Supabase / DB — no real client data", () => {
    for (const src of [PAGE, SHELL]) {
      expect(src).not.toMatch(/createClient|supabase|getCurrentPractitioner|auth\.getUser/);
    }
  });
  it("runs no server actions and no payment/email/SMS", () => {
    for (const src of [PAGE, SHELL]) {
      expect(src).not.toMatch(/"use server"|bookAppointment|stripe|sendEmail|twilio|sendSms/i);
    }
  });
  it("renders only fabricated data", () => {
    expect(PAGE).toMatch(/preview-/);
    expect(PAGE).toMatch(/fakeAppt|fakeBlock/);
  });
});

describe("preview harness exercises the REAL mobile timeline", () => {
  it("renders the actual MobileDayTimeline via the preview shell", () => {
    expect(PAGE).toMatch(/<MobilePreviewShell/);
    expect(SHELL).toMatch(/<MobileDayTimeline/);
    expect(SHELL).toMatch(/from "@\/app\/\(app\)\/calendar\/MobileDayTimeline"/);
  });
  it("booking/edit is inert in preview (taps show a note, no drawer)", () => {
    expect(SHELL).toMatch(/onBookAt=\{\(t\) => setNote/);
    expect(SHELL).not.toMatch(/QuickBookDrawer|TimedBlockEditDrawer/);
  });
});

describe("middleware allowlists /preview/ (else unauth users bounce to /login)", () => {
  it("treats /preview/ as a public route", () => {
    expect(MW).toMatch(/pathname\.startsWith\("\/preview\/"\)/);
  });
});
