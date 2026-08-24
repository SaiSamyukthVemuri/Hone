import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ===========================================================================
// WAIT-02B STAGE B1 — THE DISCLOSURE, AND THE GATE THAT DEPENDS ON IT
// ===========================================================================
//
// These three facts are pinned in ONE file on purpose, because they are one
// fact split across three places:
//
//   1. app/privacy/page.tsx covers a prospective client who has not booked;
//   2. the public waitlist form says so at the point of collection and links
//      to the policy;
//   3. scripts/check-production-env-gates.mjs therefore no longer forbids
//      production from naming a studio.
//
// (3) was correct ONLY while (1) was false. Stage A's blanket prohibition
// existed because the notice scoped itself to practitioners and to clients
// whose details a practitioner enters, so a waitlist prospect fell outside
// every disclosed category. If (1) or (2) is ever deleted while (3) stays
// permissive, production could collect prospect data with no notice covering
// it — so deleting either one has to break the same test that permits the
// activation.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRIVACY = read("app/privacy/page.tsx");
const FORM = read("app/book/[slug]/NewClientWaitlistForm.tsx");
const GATE = read("scripts/check-production-env-gates.mjs");

vi.mock("@/app/book/[slug]/waitlist-actions", () => ({
  submitNewClientBookingWaitlistAction: async () => ({ ok: true as const }),
}));

const { NewClientWaitlistForm } = await import(
  "@/app/book/[slug]/NewClientWaitlistForm"
);

const waitlistHtml = () =>
  renderToStaticMarkup(
    createElement(NewClientWaitlistForm, {
      slug: "willow-electrolysis",
      studioName: "Willow Electrolysis",
      onContinueAsExistingClient: () => {},
    }),
  );

// ---------------------------------------------------------------------------
// A. THE POLICY COVERS A PERSON WHO HAS NOT BOOKED
// ---------------------------------------------------------------------------
describe("privacy policy — prospective client / waitlist coverage", () => {
  it("SCOPE names prospective clients as a covered category, alongside the two that existed", () => {
    // The two pre-existing categories must survive: this adds a third, it does
    // not re-scope the policy.
    expect(PRIVACY).toMatch(/<strong>Practitioners<\/strong>/);
    expect(PRIVACY).toMatch(/<strong>Clients<\/strong>/);
    expect(PRIVACY).toMatch(/<strong>Prospective clients<\/strong>/);
  });

  it("says coverage does NOT depend on booking, or on a practitioner entering anything", () => {
    // The exact two implications Stage A recorded as untrue of the old notice.
    expect(PRIVACY).toMatch(/before becoming a client at all/);
    expect(PRIVACY).toMatch(/whether or not you ever book/);
    expect(PRIVACY).toMatch(
      /whether or not a practitioner has\s+ever entered anything about you/,
    );
  });

  it("has a collection section for information the PROSPECT supplies directly", () => {
    expect(PRIVACY).toMatch(/id="from-prospective-clients"/);
    expect(PRIVACY).toMatch(/From prospective clients directly/);
    expect(PRIVACY).toMatch(/no practitioner\s+enters it/);
    expect(PRIVACY).toMatch(/you do not need an account/);
  });

  it("enumerates exactly what the waitlist form actually collects, and no more", () => {
    // Name, email, optional phone, which studio, when, and the waiting/removed
    // status. That is the whole of new_client_waitlist_entries' personal data.
    expect(PRIVACY).toMatch(/Your name and email address/);
    expect(PRIVACY).toMatch(/Your phone number, if you choose to give one; it is optional/);
    expect(PRIVACY).toMatch(/Which studio&rsquo;s waitlist you joined, and when/);
    expect(PRIVACY).toMatch(/Whether you are still waiting, or have been removed/);
  });

  it("does NOT over-claim: no health data is asked for, and no client record is created", () => {
    expect(PRIVACY).toMatch(/does not ask for health\s+information|does not ask for health information/);
    expect(PRIVACY).toMatch(
      /joining a waitlist does not create a client record, an\s+appointment, or an intake form/,
    );
  });

  it("states the PURPOSE the data is used for", () => {
    expect(PRIVACY).toMatch(
      /Run a studio&rsquo;s new-client waitlist on its behalf, and let that\s+studio contact you about availability/,
    );
  });

  it("states who the entry is shared with, and that it is single-studio", () => {
    expect(PRIVACY).toMatch(/With the studio whose waitlist you joined/);
    expect(PRIVACY).toMatch(/visible only to that studio/);
    expect(PRIVACY).toMatch(/not shared with\s+any other studio/);
  });

  it("gives a prospect a removal / access route that does not need an account", () => {
    expect(PRIVACY).toMatch(/If you joined a studio&rsquo;s new-client waitlist<\/strong>/);
    expect(PRIVACY).toMatch(/contact the studio/);
    expect(PRIVACY).toMatch(/privacy@hone\.care/);
    expect(PRIVACY).toMatch(/You do not need\s+an account with us to make either request/);
  });

  // THE ONE THE STAGE-A RECORD CALLED OUT: no retention policy covers this data
  // yet. The policy must say that truthfully rather than invent a period.
  it("describes waitlist retention TRUTHFULLY and invents no statutory period", () => {
    expect(PRIVACY).toMatch(/A <strong>new-client waitlist entry<\/strong> is kept for as long as the\s+studio keeps it/);
    // Removal is a terminal status transition that RETAINS the row. Say so.
    expect(PRIVACY).toMatch(/marked as removed and retained/);
    expect(PRIVACY).toMatch(/We do not currently run an automatic timed\s+purge of waitlist entries/);
    expect(PRIVACY).toMatch(/we do not claim any fixed retention\s+period for them/);
  });

  it("invents no new statutory retention number anywhere", () => {
    // The ONLY numeric retention claim the policy may carry is the pre-existing
    // billing-records line; nothing in this revision may add a second.
    const years = [...PRIVACY.matchAll(/(\d+)\s*years?/gi)].map((m) => m[0]);
    expect(years).toEqual(["7 years"]);
  });
});

// ---------------------------------------------------------------------------
// B. THE POLICY DATES
// ---------------------------------------------------------------------------
describe("policy dates — the section 13 rule is stated, not invented", () => {
  it("keeps the 30-day account-holder notice promise verbatim", () => {
    expect(PRIVACY).toMatch(
      /Material changes will be\s+communicated via email to account holders at least 30 days before\s+taking effect/,
    );
  });

  it("explains what the two header dates mean, so a revision is not read as retroactive", () => {
    expect(PRIVACY).toMatch(/<strong>Effective date<\/strong> is when this policy took effect/);
    expect(PRIVACY).toMatch(/<strong>Last updated<\/strong> is when its text was last revised/);
    expect(PRIVACY).toMatch(/We\s+do not apply a revision retroactively/);
  });

  it("carries the effective date in ONE named constant, so the operator edits one line", () => {
    expect(PRIVACY).toMatch(/const EFFECTIVE_DATE = "[^"]+";/);
    expect(PRIVACY).toMatch(/const LAST_UPDATED = "[^"]+";/);
    expect(PRIVACY).toMatch(/effectiveDate=\{EFFECTIVE_DATE\}/);
    expect(PRIVACY).toMatch(/lastUpdated=\{LAST_UPDATED\}/);
  });

  it("records that the effective date is an operator/legal decision, not a repository one", () => {
    expect(PRIVACY).toMatch(/notice date \+ 30 days/);
    expect(PRIVACY).toMatch(/THIS CONSTANT IS THE ONE PLACE THAT CHANGES/);
  });

  it("the revision moved lastUpdated forward without back-dating the text", () => {
    const effective = PRIVACY.match(/const EFFECTIVE_DATE = "([^"]+)";/)?.[1];
    const lastUpdated = PRIVACY.match(/const LAST_UPDATED = "([^"]+)";/)?.[1];
    expect(effective).toBeTruthy();
    expect(lastUpdated).toBeTruthy();
    expect(Date.parse(lastUpdated as string)).toBeGreaterThan(
      Date.parse(effective as string),
    );
  });
});

// ---------------------------------------------------------------------------
// C. THE COLLECTION SURFACE
// ---------------------------------------------------------------------------
describe("public waitlist form — notice at the point of collection", () => {
  const html = waitlistHtml();

  it("names WHO stores it, WHAT is stored, and WHY", () => {
    expect(html).toContain("Willow Electrolysis and Hone will store");
    expect(html).toContain("the name, email and phone number you enter here");
    expect(html).toContain("to manage this waitlist and contact you about availability");
  });

  it("links to the privacy policy from the collection surface itself", () => {
    expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>/);
    expect(html).toMatch(/Privacy Policy<\/a>/);
  });

  it("is NOT hidden, collapsed, or visually suppressed", () => {
    const at = html.indexOf("Willow Electrolysis and Hone will store");
    // From the notice's own <p ...> tag, so its class/style attributes are in
    // scope — they sit before the text, not after it.
    const notice = html.slice(html.lastIndexOf("<p", at));
    // Same 13px secondary type as the existing not-a-reservation line, which
    // is the form's established caption size — not smaller, not lighter.
    expect(notice).toContain("text-[13px]");
    expect(notice).not.toMatch(/<details|hidden|sr-only|display:\s*none|opacity:\s*0|font-size:\s*(?:[0-9]|10|11)px/);
    // The link is underlined and inked, not blended into the muted body.
    expect(notice).toMatch(/underline/);
  });

  it("sits WITH the submit control, not in a footer far from it", () => {
    const cta = html.indexOf("Join waitlist");
    const notice = html.indexOf("Willow Electrolysis and Hone will store");
    expect(cta).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(cta);
    // Adjacent: only the not-a-reservation caption sits between them.
    expect(html.slice(cta, notice)).not.toContain("</form>");
  });

  it("adds NO consent checkbox — this collection is not separable from the request", () => {
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3); // name, email, phone — unchanged
    expect(html).not.toContain('type="checkbox"');
  });

  it("keeps the existing copy discipline: no capacity, queue or position signal", () => {
    const lower = html.toLowerCase();
    for (const forbidden of [
      "utilization", "utilisation", "capacity", "queue", "position",
      "conversion", "%", "critical", "fully booked",
    ]) {
      expect(lower, `notice must not introduce "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("the CONFIRMATION panel is untouched — it carries no new outcome-bearing copy", () => {
    // The panel receives only studioName, and this change must not have given
    // it anything that could vary with which database outcome occurred.
    expect(FORM).toMatch(/NewClientWaitlistJoinedPanel\(\{ studioName \}: \{ studioName: string \}\)/);
    expect(FORM).not.toMatch(/JoinedPanel[\s\S]{0,400}COLLECTION_NOTICE/);
  });
});

// ---------------------------------------------------------------------------
// D. THE COUPLING: the gate may only be permissive while the disclosure exists
// ---------------------------------------------------------------------------
describe("the activation guard rests on the disclosure above", () => {
  it("the Stage-A blanket prohibition is gone", () => {
    expect(GATE).not.toMatch(/stage-a-durable-waitlist-env/);
    expect(GATE).toMatch(/stage-b-durable-waitlist-env/);
  });

  it("the gate cites the disclosure it depends on, by path", () => {
    // Not decoration: it is why a populated allowlist is now permitted, and the
    // next reader has to be able to find it.
    expect(GATE).toContain("app/privacy/page.tsx");
    expect(GATE).toContain("tests/app/privacy/waitlist-prospect-disclosure.test.ts");
  });

  it("activation still requires an explicit per-studio name in production", () => {
    expect(GATE).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    expect(GATE).toMatch(/STUDIO_SLUG_RE/);
    // No bypass, no named exception.
    expect(GATE).not.toMatch(/SKIP_WAITLIST|WAITLIST_BYPASS|ALLOW_DURABLE|FORCE_DURABLE/i);
    expect(GATE.toLowerCase()).not.toContain("willow");
  });
});
