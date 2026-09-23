import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import { emptyJoinProfileDraft } from "@/lib/waitlist/join-profile";
import { joinCollectionNotice } from "@/lib/waitlist/join-copy";
import type { StoredWaitlistProfile } from "@/lib/waitlist/join-profile";

// ===========================================================================
// CONSENT IS ASKED ONLY WHERE THE WITHDRAWAL CAN BE HONOURED
// ===========================================================================
//
// `ProfileAdapterCapabilities.recordsSmsConsent` is true only when BOTH halves
// hold: the six SMS columns can be written AND an inbound STOP reaches the row.
// 0202 shipped the columns, so the first half is satisfied. The second is not:
// `app/api/twilio/inbound-sms/route.ts` reads and updates `clients` and never
// touches `new_client_waitlist_entries`.
//
// A tick offered in that state is a promise the label makes and the system
// breaks. So the control is not rendered at all — not disabled, not hidden with
// CSS. A disabled tick still says "there is a texting option here"; an absent
// one makes no offer, and an element that is not in the tree cannot be
// announced to a screen reader either.
//
// THE PROP IS REQUIRED ON PURPOSE. A default would let a future surface acquire
// the tick by forgetting a prop, which is exactly how a capability boundary
// erodes. That is asserted below against the source, because a type-level
// guarantee disappears from the compiled artefact a reviewer reads.

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const STORED: StoredWaitlistProfile = {
  firstName: null,
  lastName: null,
  legacyName: "Old Name",
  email: "legacy@example.com",
  mobile: null,
  treatmentAreaIds: null,
  availabilityPreference: null,
};

const CONSENT_BLOCK = "waitlist-sms-consent";
const CONSENT_INPUT = "waitlist-field-sms-consent";

describe("the consent control appears only when the binding can honour a STOP", () => {
  it("ProfileFields renders NO consent control when the capability is false", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileFields, {
        draft: emptyJoinProfileDraft(),
        errors: {},
        onChange: () => {},
        collectsSmsConsent: false,
      }),
    );
    expect(html).not.toContain(CONSENT_BLOCK);
    expect(html).not.toContain(CONSENT_INPUT);
  });

  it("ProfileFields renders it when the capability is true", () => {
    // The negative above would pass against a component that never renders the
    // control at all, so the positive case is what makes it a gate rather than
    // a deletion.
    const html = renderToStaticMarkup(
      createElement(ProfileFields, {
        draft: emptyJoinProfileDraft(),
        errors: {},
        onChange: () => {},
        collectsSmsConsent: true,
      }),
    );
    expect(html).toContain(CONSENT_BLOCK);
    expect(html).toContain(CONSENT_INPUT);
  });

  it("the rest of the profile still renders when consent is withheld", () => {
    // Withholding the QUESTION must not withhold the form. If gating the tick
    // also dropped the fields, the surface would be unusable in exactly the
    // state it ships in today.
    const html = renderToStaticMarkup(
      createElement(ProfileFields, {
        draft: emptyJoinProfileDraft(),
        errors: {},
        onChange: () => {},
        collectsSmsConsent: false,
      }),
    );
    for (const field of [
      "waitlist-field-first-name",
      "waitlist-field-last-name",
      "waitlist-profile-fields",
    ]) {
      expect(html, field).toContain(field);
    }
  });

  it("a draft already carrying consent cannot smuggle the control back", () => {
    // The gate is on the CAPABILITY, never on the draft value. A pre-filled or
    // tampered draft with `smsOperationalConsent: true` must not cause the
    // question to appear where it may not be asked.
    const html = renderToStaticMarkup(
      createElement(ProfileFields, {
        draft: { ...emptyJoinProfileDraft(), smsOperationalConsent: true },
        errors: {},
        onChange: () => {},
        collectsSmsConsent: false,
      }),
    );
    expect(html).not.toContain(CONSENT_BLOCK);
    expect(html).not.toContain(CONSENT_INPUT);
  });
});

describe("both shipped surfaces pass the capability through", () => {
  for (const [name, render] of [
    [
      "WaitlistJoinForm",
      (on: boolean) =>
        renderToStaticMarkup(
          createElement(WaitlistJoinForm, {
            studioName: "Willow",
            onSubmit: async () => ({ ok: true }) as const,
            collectsSmsConsent: on,
          }),
        ),
    ],
    [
      "CompleteProfilePanel",
      (on: boolean) =>
        renderToStaticMarkup(
          createElement(CompleteProfilePanel, {
            studioName: "Willow",
            stored: STORED,
            onSubmit: async () => ({ ok: true }) as const,
            collectsSmsConsent: on,
          }),
        ),
    ],
  ] as const) {
    it(`${name} withholds the control when the capability is false`, () => {
      expect(render(false)).not.toContain(CONSENT_INPUT);
    });

    it(`${name} offers it when the capability is true`, () => {
      expect(render(true)).toContain(CONSENT_INPUT);
    });
  }
});

describe("the disclosure enumerates only what is actually collected", () => {
  // A point-of-collection notice is the one sentence that has to be exactly
  // true. Gating the consent QUESTION off while the notice still said the
  // submitted details include "whether you agreed to text messages" would tell
  // a prospect that an answer they were never asked for would be used — the
  // same class of untruth as describing collection nobody performs, pointed at
  // a field instead of a policy.
  const TEXT_CLAUSE = "whether you agreed to text messages";

  it("omits the consent clause when the question is not asked", () => {
    expect(joinCollectionNotice(false)).not.toContain(TEXT_CLAUSE);
  });

  it("includes it when the question IS asked", () => {
    expect(joinCollectionNotice(true)).toContain(TEXT_CLAUSE);
  });

  it("both wordings still enumerate the fields that are always collected", () => {
    // The clause is the ONLY difference. Dropping it must not quietly drop the
    // rest of the sentence, which is what a hand-written second string would
    // eventually do.
    for (const on of [true, false]) {
      const notice = joinCollectionNotice(on);
      for (const field of ["name", "email", "mobile number", "treatment areas", "availability"]) {
        expect(notice, `${on}: ${field}`).toContain(field);
      }
      expect(notice, `${on}: purpose`).toContain("to manage this waitlist");
    }
  });

  for (const [name, render] of [
    [
      "WaitlistJoinForm",
      (on: boolean) =>
        renderToStaticMarkup(
          createElement(WaitlistJoinForm, {
            studioName: "Willow",
            onSubmit: async () => ({ ok: true }) as const,
            collectsSmsConsent: on,
          }),
        ),
    ],
    [
      "CompleteProfilePanel",
      (on: boolean) =>
        renderToStaticMarkup(
          createElement(CompleteProfilePanel, {
            studioName: "Willow",
            stored: STORED,
            onSubmit: async () => ({ ok: true }) as const,
            collectsSmsConsent: on,
          }),
        ),
    ],
  ] as const) {
    it(`${name} renders a notice that matches its own question`, () => {
      // The end-to-end version of the two assertions above: whatever the
      // surface asked, the sentence beneath the button agrees with it.
      expect(render(false)).not.toContain(TEXT_CLAUSE);
      expect(render(true)).toContain(TEXT_CLAUSE);
    });
  }
});

describe("the capability cannot be acquired by omission", () => {
  it("every surface declares the prop as REQUIRED, not defaulted", () => {
    // `collectsSmsConsent?: boolean` or `collectsSmsConsent = false` would both
    // compile and both would let a new call site render the tick — or silently
    // drop it — without stating a decision. The whole point of the prop is that
    // the decision is visible at every call site.
    for (const file of [
      "components/waitlist/profile-fields.tsx",
      "components/waitlist/waitlist-join-form.tsx",
      "components/waitlist/complete-profile-panel.tsx",
    ]) {
      const text = src(file);
      expect(text, `${file} declares the prop`).toMatch(
        /collectsSmsConsent:\s*boolean;/,
      );
      expect(text, `${file} must not make it optional`).not.toMatch(
        /collectsSmsConsent\?\s*:/,
      );
      expect(text, `${file} must not default it`).not.toMatch(
        /collectsSmsConsent\s*=\s*(true|false)/,
      );
    }
  });

  it("the control lives behind the gate, not beside it", () => {
    // Guards the shape rather than the outcome: the consent block must be
    // inside the conditional. A later edit that moves it out would keep every
    // render assertion above green only if it also changed the capability, and
    // this fails immediately instead.
    const text = src("components/waitlist/profile-fields.tsx");
    const gate = text.indexOf("{collectsSmsConsent && (");
    const block = text.indexOf(`data-testid="${CONSENT_BLOCK}"`);
    expect(gate, "the gate exists").toBeGreaterThan(-1);
    expect(block, "the block exists").toBeGreaterThan(-1);
    expect(block, "the block is inside the gate").toBeGreaterThan(gate);
  });
});
