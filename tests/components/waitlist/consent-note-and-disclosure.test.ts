import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import {
  emptyJoinProfileDraft,
  type JoinProfileDraft,
} from "@/lib/waitlist/join-profile";
import {
  SMS_OPERATIONAL_CONSENT_DECLINED_NOTE,
  SMS_OPERATIONAL_CONSENT_LABEL,
} from "@/lib/waitlist/prospect-sms-consent";
import {
  JOIN_COLLECTION_NOTICE,
  PRIVACY_POLICY_PATH,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// #687 — TWO PRESENTATION FINDINGS
//
// P2 A (3974516978) the declined-only note stayed rendered and stayed referenced
//                   by aria-describedby when consent was CHECKED, so the control
//                   announced "we'll email you instead" to someone who had just
//                   opted into texts — and only to screen-reader users, who heard
//                   the opposite of what the sighted label said.
//
// P2 B (3974516987) the new join surface carried no collection notice and no
//                   Privacy Policy link, both of which the shipped form has. A
//                   component intended to replace it would have dropped a live
//                   public disclosure.
// ===========================================================================

function fieldsWith(consent: boolean): string {
  const draft: JoinProfileDraft = {
    ...emptyJoinProfileDraft(),
    smsOperationalConsent: consent,
  };
  return renderToStaticMarkup(
    createElement(ProfileFields, { draft, errors: {}, onChange: () => {} }),
  );
}

/** Tags stripped, entities decoded — copy compared as a reader sees it. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;|—/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

/** The ids an element's aria-describedby points at. */
function describedByOf(html: string, testId: string): string[] {
  const tag = html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
  const value = tag.match(/aria-describedby="([^"]+)"/)?.[1];
  return value ? value.split(/\s+/) : [];
}

describe("P2 A — UNCHECKED: the declined note is allowed", () => {
  const html = fieldsWith(false);

  it("renders the declined note", () => {
    expect(visibleText(html)).toContain(SMS_OPERATIONAL_CONSENT_DECLINED_NOTE);
  });

  it("and aria-describedby may point at it", () => {
    const ids = describedByOf(html, "waitlist-field-sms-consent");
    expect(ids).toHaveLength(1);
    // The referenced element must exist and be the note.
    expect(html).toContain(`id="${ids[0]}"`);
    const noteTag = html.match(new RegExp(`<p[^>]*id="${ids[0]}"[^>]*>([^<]*)<`))?.[1] ?? "";
    expect(visibleText(noteTag)).toContain(SMS_OPERATIONAL_CONSENT_DECLINED_NOTE);
  });

  it("the box is unchecked", () => {
    expect(html).not.toMatch(/data-testid="waitlist-field-sms-consent"[^>]*checked/);
  });
});

describe("P2 A — CHECKED: declined-only copy is gone, in markup and in aria", () => {
  const html = fieldsWith(true);

  it("the box IS checked (non-vacuity for everything below)", () => {
    expect(html).toMatch(/data-testid="waitlist-field-sms-consent"[^>]*checked/);
  });

  it("CHECKED_DECLINE_NOTE_ABSENT — the note does not render at all", () => {
    // Absent, not merely hidden: a CSS-hidden element stays in the
    // accessibility tree and would still be announced.
    expect(visibleText(html)).not.toContain(SMS_OPERATIONAL_CONSENT_DECLINED_NOTE);
    expect(html).not.toContain("We'll email you instead");
    expect(html).not.toContain("email you instead");
  });

  it("CHECKED_ARIA_REFERENCE_ABSENT — nothing describes it with declined copy", () => {
    expect(describedByOf(html, "waitlist-field-sms-consent")).toEqual([]);
    expect(html).not.toMatch(/data-testid="waitlist-field-sms-consent"[^>]*aria-describedby/);
  });

  it("no dangling aria-describedby anywhere in the render", () => {
    // Every id referenced must exist — a reference to a removed element is
    // worse than none, because AT resolves it to nothing silently.
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
      for (const id of m[1].split(/\s+/)) {
        expect(html).toContain(`id="${id}"`);
      }
    }
  });

  it("the label still states the agreement and the way out", () => {
    // The checked state needs no substitute description because this is present.
    expect(visibleText(html)).toContain(SMS_OPERATIONAL_CONSENT_LABEL);
    expect(visibleText(html)).toContain("STOP");
  });
});

describe("P2 B — the join surface preserves the public disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(WaitlistJoinForm, {
      studioName: "Willow",
      onSubmit: async () => ({ ok: true }) as const,
    }),
  );
  const text = visibleText(html);

  it("COLLECTION_NOTICE_PRESENT — names the studio, Hone, and the purpose", () => {
    expect(text).toContain(JOIN_COLLECTION_NOTICE);
    expect(text).toContain("Willow and Hone");
  });

  it("enumerates every category this form actually collects", () => {
    for (const field of [
      "name",
      "email",
      "mobile number",
      "treatment areas",
      "availability",
      "text messages",
    ]) {
      expect(JOIN_COLLECTION_NOTICE).toContain(field);
    }
  });

  it("PRIVACY_LINK_PRESENT — a real anchor to the policy", () => {
    expect(html).toContain(`href="${PRIVACY_POLICY_PATH}"`);
    expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>\s*Privacy Policy\s*<\/a>/);
    expect(text).toContain("Privacy Policy");
  });

  it("does NOT claim the data is already collected in production", () => {
    // The component is dormant. A present-tense claim about live practice would
    // be untrue, and is WAIT-04B's to make when it wires the surface.
    expect(JOIN_COLLECTION_NOTICE).not.toMatch(/we (already|currently) (store|collect)/i);
    expect(JOIN_COLLECTION_NOTICE).not.toMatch(/is stored in|has been stored/i);
  });

  it("speaks the SHIPPED form's vocabulary, not a second one", () => {
    const shipped = readFileSync(
      path.join(process.cwd(), "app/book/[slug]/NewClientWaitlistForm.tsx"),
      "utf8",
    );
    // Same verb, same sentence frame, same destination as the live disclosure.
    expect(shipped).toContain('href="/privacy"');
    expect(shipped).toMatch(/and Hone \{COLLECTION_NOTICE\}/);
    expect(JOIN_COLLECTION_NOTICE.startsWith("use ")).toBe(true);
    expect(JOIN_COLLECTION_NOTICE).toContain("to manage this waitlist");
  });
});

describe("SCOPE — this repair did not reach for the forbidden", () => {
  it("the live Privacy Policy page is not modified by this PR", () => {
    // WAIT-04B updates it atomically with activation; doing it here would
    // describe collection nobody performs yet.
    const policy = readFileSync(path.join(process.cwd(), "app/privacy/page.tsx"), "utf8");
    for (const premature of [
      "treatment areas and availability",
      "availability preference",
      "sms_consent_at",
    ]) {
      expect(policy).not.toContain(premature);
    }
  });

  it("the obligation to update it is RECORDED, not forgotten", () => {
    const contract = readFileSync(
      path.join(process.cwd(), "lib/waitlist/profile-binding-contract.ts"),
      "utf8",
    );
    expect(contract).toContain("privacy_policy_describes_activated_collection");
    expect(contract).toMatch(/SAME change that activates collection/i);
  });

  it("the shipped public form is still byte-unchanged by this PR", () => {
    const shipped = readFileSync(
      path.join(process.cwd(), "app/book/[slug]/NewClientWaitlistForm.tsx"),
      "utf8",
    );
    // Its notice stays module-private; exporting it would edit production code.
    expect(shipped).toContain("const COLLECTION_NOTICE =");
    expect(shipped).not.toContain("export const COLLECTION_NOTICE");
  });
});
