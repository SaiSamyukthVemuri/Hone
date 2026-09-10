import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import {
  completionDraftFromStored,
  validateJoinProfileDraft,
  invitationEligibility,
  storedMobilePresent,
  type JoinProfileDraft,
  type StoredWaitlistProfile,
} from "@/lib/waitlist/join-profile";
import {
  MOBILE_CANDIDATE_NOTE,
  MOBILE_ON_FILE_NOTE,
  MOBILE_ON_FILE_UNUSABLE,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// #687 P1 — A REFUSED SAVE MUST SAY SO
// ===========================================================================
//
// The defect: a stored mobile that is PRESENT but INVALID ("n/a", "ask", "123")
// is locked (presence keeps it immutable) AND fails validation (completeness
// needs a real number). `CompleteProfilePanel.submit` therefore sets errors and
// returns before `onSubmit` — while the locked branch rendered no error at all.
// The prospect pressed Save forever against a form that changed nothing.
//
// ---------------------------------------------------------------------------
// HOW "onSubmit CALLED ZERO TIMES" IS PROVED HERE, AND HOW IT IS NOT
// ---------------------------------------------------------------------------
//
// This repo has NO DOM test environment — vitest runs `environment: "node"`, and
// jsdom, happy-dom and @testing-library are all absent. A test cannot click the
// Save button. Adding a DOM library would be a package.json change, which
// CLAUDE.md classifies as shared infra and routes to the FULL CI matrix; that is
// disproportionate to a copy-and-aria repair.
//
// So the guarantee is proved at its decision point instead. The panel's submit is
// exactly:
//
//     const validated = validateJoinProfileDraft(draft);
//     if (!validated.ok) { setErrors(validated.errors); return; }   // <- here
//     ... await onSubmit(...)
//
// so "onSubmit is unreachable" is identical to "validateJoinProfileDraft(draft)
// is not ok" for the draft the panel actually builds. Each junk value below is
// asserted against `validateJoinProfileDraft(completionDraftFromStored(stored))`
// — the same construction, not a re-typed approximation — and a source guard
// pins the ordering so the equivalence cannot quietly stop holding.
// ===========================================================================

/** Every other required field valid, so `mobile` is the ONLY thing failing. */
function draftFor(stored: StoredWaitlistProfile): JoinProfileDraft {
  return {
    ...completionDraftFromStored(stored),
    firstName: "Sarah",
    lastName: "Jones",
    treatmentAreaIds: ["chin"],
    availabilityPreference: "both",
  };
}

function fieldsMarkup(stored: StoredWaitlistProfile) {
  const draft = draftFor(stored);
  const validated = validateJoinProfileDraft(draft);
  const errors = validated.ok ? {} : validated.errors;
  return {
    validated,
    errors,
    html: renderToStaticMarkup(
      createElement(ProfileFields, {
        draft,
        errors,
        onChange: () => {},
        emailLocked: true,
        mobileLocked: storedMobilePresent(stored),
        showMobileCandidateNote: !storedMobilePresent(stored),
      }),
    ),
  };
}

/** Tags stripped, entities decoded — copy compared as a reader sees it. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const JUNK = ["n/a", "ask", "unknown", "-", "123", "x".repeat(45)];

describe("1+2. LOCKED INVALID MOBILE — refusal is visible, and Save cannot proceed", () => {
  for (const stored of JUNK) {
    describe(`stored.mobile = ${JSON.stringify(stored)}`, () => {
      const entry = { email: "sarah@example.com", mobile: stored };
      const { html, errors, validated } = fieldsMarkup(entry);

      it("stays LOCKED — the number is present, so it is immutable", () => {
        expect(storedMobilePresent(entry)).toBe(true);
        expect(html).toContain('data-testid="waitlist-field-mobile-locked"');
      });

      it("offers NO editable mobile field", () => {
        expect(html).not.toContain('data-testid="waitlist-field-mobile"');
        expect(html).not.toContain('type="tel"');
      });

      it("mobile is the ONLY failing field", () => {
        expect(errors.mobile).toBeTruthy();
        expect(Object.keys(errors)).toEqual(["mobile"]);
      });

      it("renders a VISIBLE role=alert naming the remediation", () => {
        expect(html).toContain('data-testid="waitlist-field-mobile-locked-error"');
        expect(html).toMatch(/role="alert"/);
        const text = visibleText(html);
        expect(text).toContain(MOBILE_ON_FILE_UNUSABLE);
        // Points at a human, NOT at a field that is deliberately absent.
        expect(text).toMatch(/contact the studio/i);
        expect(text).not.toContain("Enter a mobile number");
      });

      it("does NOT reuse the calm on-file note as the error", () => {
        expect(visibleText(html)).not.toContain(MOBILE_ON_FILE_NOTE);
      });

      it("onSubmit is UNREACHABLE — the panel's guard refuses first", () => {
        // Identical to "onSubmit called zero times": the panel returns on a
        // failed validation before it can be invoked.
        expect(validated.ok).toBe(false);
      });

      it("and Save does not appear to succeed", () => {
        // The done panel is what a successful save renders; it must be absent.
        const panel = renderToStaticMarkup(
          createElement(CompleteProfilePanel, {
        studioName: "Willow",
            stored: entry,
            onSubmit: async () => ({ ok: true }) as const,
          }),
        );
        expect(panel).not.toContain('data-testid="waitlist-completion-done"');
        expect(panel).toContain('data-testid="waitlist-completion-form"');
      });
    });
  }
});

describe("3. LOCKED VALID MOBILE — nothing changes for the healthy case", () => {
  const entry = {
    firstName: "Sarah",
    lastName: "Jones",
    email: "sarah@example.com",
    mobile: "07700900000",
    treatmentAreaIds: ["chin"],
    availabilityPreference: "both",
  };
  const { html, errors, validated } = fieldsMarkup(entry);

  it("renders the locked branch", () => {
    expect(html).toContain('data-testid="waitlist-field-mobile-locked"');
    expect(visibleText(html)).toContain("07700900000");
  });

  it("keeps MOBILE_ON_FILE_NOTE", () => {
    expect(visibleText(html)).toContain(MOBILE_ON_FILE_NOTE);
  });

  it("raises no validation error and no alert", () => {
    expect(errors.mobile).toBeUndefined();
    expect(html).not.toContain('data-testid="waitlist-field-mobile-locked-error"');
    expect(html).not.toContain('role="alert"');
  });

  it("a fully valid form reaches onSubmit", () => {
    // The guard passes, so the panel proceeds to its single onSubmit call.
    expect(validated.ok).toBe(true);
  });
});

describe("4. ABSENT MOBILE — the legacy collection path is untouched", () => {
  for (const empty of [null, "", undefined]) {
    it(`renders an editable field for mobile = ${JSON.stringify(empty)}`, () => {
      const entry = { email: "sarah@example.com", mobile: empty };
      const { html } = fieldsMarkup(entry);
      expect(storedMobilePresent(entry)).toBe(false);
      expect(html).toContain('data-testid="waitlist-field-mobile"');
      expect(html).not.toContain('data-testid="waitlist-field-mobile-locked"');
      expect(html).not.toContain('data-testid="waitlist-field-mobile-locked-error"');
      expect(visibleText(html)).toContain(MOBILE_CANDIDATE_NOTE);
    });
  }

  it("a typed valid mobile can submit", () => {
    const draft = {
      ...draftFor({ email: "sarah@example.com", mobile: null }),
      mobile: "07700900123",
    };
    expect(validateJoinProfileDraft(draft).ok).toBe(true);
  });
});

describe("ACCESSIBILITY — the alert is reachable, not decorative", () => {
  const { html } = fieldsMarkup({ email: "sarah@example.com", mobile: "n/a" });

  it("the locked region is a NAMED group described by the error", () => {
    const region = html.match(/<div[^>]*waitlist-field-mobile-locked"[^>]*>/)?.[0] ?? "";
    expect(region).toContain('role="group"');
    expect(region).toMatch(/aria-labelledby="[^"]+"/);
    const describedBy = region.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    // The described id must be the ERROR's id, and that element must exist.
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(
      new RegExp(`id="${describedBy}"[^>]*role="alert"|role="alert"[^>]*id="${describedBy}"`),
    );
  });

  it("the error id is stable within a render, not regenerated per element", () => {
    const ids = html.match(/id="([^"]+)"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids anywhere
  });

  it("points at the NOTE's id instead when the number is valid", () => {
    const ok = fieldsMarkup({
      email: "sarah@example.com",
      mobile: "07700900000",
      firstName: "Sarah",
      lastName: "Jones",
      treatmentAreaIds: ["chin"],
      availabilityPreference: "both",
    }).html;
    const region = ok.match(/<div[^>]*waitlist-field-mobile-locked"[^>]*>/)?.[0] ?? "";
    const describedBy = region.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(ok).toContain(`id="${describedBy}"`);
    expect(ok).not.toContain('role="alert"');
  });
});

describe("SOURCE GUARD — the guard-before-onSubmit ordering the proof relies on", () => {
  it("the panel refuses on invalid validation BEFORE calling onSubmit", () => {
    const src = readPanelSource();
    const guard = src.indexOf("if (!validated.ok)");
    const call = src.indexOf("await onSubmit(");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    // If this ordering ever inverts, "validation fails" stops implying
    // "onSubmit is unreachable" and every proof above weakens silently.
    expect(guard).toBeLessThan(call);
    expect(src.slice(guard, call)).toContain("return;");
  });
});

function readPanelSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  return readFileSync(
    path.join(process.cwd(), "components/waitlist/complete-profile-panel.tsx"),
    "utf8",
  );
}


describe("the refusal copy promises nothing the product cannot do", () => {
  // The operator queue exposes remove / claim / release / expire / requeue /
  // claim-next and NONE writes a phone; the page renders `phone` with no input,
  // and no migration provides an RPC that updates one. So the studio can see a
  // bad number and remove the person — it cannot correct the number. Copy that
  // said otherwise sent the prospect to a capability that does not exist.

  it("does NOT claim the studio can update the number", () => {
    for (const promise of [
      /to update it/i,
      /studio to update/i,
      /studio can update/i,
      /studio will update/i,
      /we'll update/i,
      /have it updated/i,
    ]) {
      expect(MOBILE_ON_FILE_UNUSABLE).not.toMatch(promise);
    }
  });

  it("does NOT promise a return trip that would hit the same refusal", () => {
    expect(MOBILE_ON_FILE_UNUSABLE).not.toMatch(/come back|return here|then finish/i);
  });

  it("does NOT promise contact by email, which an incomplete entry cannot get", () => {
    // invitationEligibility refuses an incomplete profile on EVERY channel, so
    // an email reassurance would be as false as the update promise it replaced.
    expect(MOBILE_ON_FILE_UNUSABLE).not.toMatch(/email you|be in touch|contact you/i);
  });

  it("NON-VACUITY — it still says the three true things and names one action", () => {
    expect(MOBILE_ON_FILE_UNUSABLE).toMatch(/can't use the mobile number/i);
    expect(MOBILE_ON_FILE_UNUSABLE).toMatch(/can't be changed from this page/i);
    expect(MOBILE_ON_FILE_UNUSABLE).toMatch(/can't be completed/i);
    expect(MOBILE_ON_FILE_UNUSABLE).toMatch(/contact the studio/i);
  });

  it("and the entry it describes really is uninvitable, on every channel", () => {
    const verdict = invitationEligibility({
      firstName: "Sarah",
      lastName: "Jones",
      email: "sarah@example.com",
      mobile: "n/a",
      treatmentAreaIds: ["chin"],
      availabilityPreference: "both",
    });
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) return;
    expect(verdict.reason).toBe("profile_incomplete");
  });
});
