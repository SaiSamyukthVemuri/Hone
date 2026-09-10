import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import { emptyJoinProfileDraft } from "@/lib/waitlist/join-profile";
import {
  JOIN_COLLECTION_NOTICE,
  PRIVACY_POLICY_PATH,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// THE POINT-OF-COLLECTION DISCLOSURE — PROVED ON THE SURFACES THAT EXIST
// ===========================================================================
//
// THE INVARIANT: every public profile-collection SUBMISSION surface renders the
// same disclosure, adjacent to its submission action, from one owner —
// `PublicCollectionSubmit`, which owns the CTA, the notice and the Privacy
// Policy link together.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE NO LONGER CLAIMS, AND WHY
// ---------------------------------------------------------------------------
//
// A previous revision tried to DISCOVER collection surfaces automatically, so
// that a future component could not add one without acquiring the disclosure.
// It was attempted three times and was incomplete three times:
//
//   1. `/type="submit"/` missed an implicit submit — a <button> inside a <form>
//      with no `type` IS a submit button by HTML default;
//   2. handling implicit <button> and `<input type="submit">` missed submit
//      semantics hidden inside a component — `<Button type="submit">`;
//   3. resolving that would have required interpreting arbitrary React
//      composition, where the next spelling escapes again.
//
// Each round was the same shape: a rule stated correctly in prose and
// implemented more narrowly in code, then patched at exactly the spelling that
// had just escaped. The completeness claim was never true; it was only untested
// in the direction that would have falsified it.
//
// SO THE CLAIM IS RETIRED RATHER THAN PATCHED A FOURTH TIME. This file proves
// the property DIRECTLY, on the two surfaces that exist today, by rendering
// them and reading the output. It makes no statement about components that do
// not yet exist.
//
// A NEW PUBLIC PROFILE-COLLECTION SURFACE MUST JOIN THIS CONTRACT DURING ITS
// OWN REVIEW. That is a development and review obligation, and naming it here
// is more honest than a guard that reports completeness it cannot deliver — a
// guard believed to be exhaustive is worse than none, because it stops anyone
// looking.
// ===========================================================================

/**
 * The current collection surfaces, enumerated deliberately.
 *
 * Census taken at this head: `<ProfileFields` is rendered in exactly two
 * components, and `<PublicCollectionSubmit` in the same two. Everything else
 * naming either only mentions it — a boolean field on the binding contract, and
 * prose inside the owner itself.
 */
const SURFACES = [
  {
    rel: "components/waitlist/waitlist-join-form.tsx",
    html: renderToStaticMarkup(
      createElement(WaitlistJoinForm, {
        studioName: "Willow",
        onSubmit: async () => ({ ok: true }) as const,
      }),
    ),
  },
  {
    rel: "components/waitlist/complete-profile-panel.tsx",
    html: renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        studioName: "Willow",
        stored: { legacyName: "Sarah Jones", email: "sarah@example.com" },
        onSubmit: async () => ({ ok: true }) as const,
      }),
    ),
  },
] as const;

const sourceOf = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

/** Tags stripped, entities decoded — copy compared as a reader sees it. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("each current surface has EXACTLY ONE disclosure owner", () => {
  for (const { rel } of SURFACES) {
    describe(rel, () => {
      const source = sourceOf(rel);

      it("imports the owner it renders", () => {
        expect(source).toContain('from "@/components/waitlist/public-collection-submit"');
      });

      it("renders the owner exactly once — not zero, not twice", () => {
        // Zero is the original defect: a CTA with no notice. Two means either
        // two CTAs or a stray duplicate notice.
        expect(source.match(/<PublicCollectionSubmit\b/g) ?? []).toHaveLength(1);
      });

      it("holds no second local disclosure copy", () => {
        // One owner, one string. The Privacy Policy destination is INHERITED
        // rather than restated, which is why removing it from the owner breaks
        // both surfaces at once instead of silently breaking one.
        expect(source).not.toContain("JOIN_COLLECTION_NOTICE");
        expect(source).not.toContain(PRIVACY_POLICY_PATH);
        expect(source).not.toContain("Privacy Policy");
      });
    });
  }
});

describe("each current surface RENDERS the disclosure, adjacent to its submit", () => {
  for (const { rel, html } of SURFACES) {
    describe(rel, () => {
      const text = visibleText(html);

      it("renders the notice, naming the studio", () => {
        expect(html).toContain('data-testid="public-collection-notice"');
        expect(text).toContain(JOIN_COLLECTION_NOTICE);
        expect(text).toContain("Willow and Hone");
      });

      it("inherits the shared Privacy Policy destination", () => {
        expect(html).toContain('data-testid="public-collection-privacy-link"');
        expect(html).toMatch(
          new RegExp(`<a[^>]*href="${PRIVACY_POLICY_PATH}"[^>]*>\\s*Privacy Policy\\s*</a>`),
        );
      });

      it("the notice sits inside the same block as the submit control", () => {
        const block =
          html.match(
            /<div[^>]*data-testid="public-collection-submit"[\s\S]*?data-testid="public-collection-notice"[\s\S]*?<\/p>/,
          ) ?? [];
        expect(block.length).toBeGreaterThan(0);
        expect(block[0]).toContain('type="submit"');
      });

      it("renders ONE control, and it is explicitly the owner's submit", () => {
        // COUNTING THE RENDERED CONTROLS, NOT A SOURCE SPELLING. `type="submit"`
        // alone would miss the escape that started this whole sequence: a
        // <button> inside a <form> with NO type IS a submit by HTML default and
        // emits no such attribute. So the assertion is on the CONTROLS
        // THEMSELVES — one button, explicitly typed, no untyped button, no
        // input-submit. Bounded to these two surfaces: it discovers nothing and
        // says nothing about any other component.
        const buttons = html.match(/<button[^>]*>/g) ?? [];
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toContain('type="submit"');
        expect(
          buttons.filter((b) => !/type="/.test(b)),
          "an untyped button inside a form submits by default",
        ).toEqual([]);
        expect(html.match(/<input[^>]*type="submit"/g) ?? []).toHaveLength(0);
      });

      it("renders the notice, the link and the control EXACTLY ONCE each", () => {
        expect(html.match(/data-testid="public-collection-notice"/g) ?? []).toHaveLength(1);
        expect(html.match(/href="\/privacy"/g) ?? []).toHaveLength(1);
        expect(html.match(/type="submit"/g) ?? []).toHaveLength(1);
      });
    });
  }
});

describe("a NON-submission ProfileFields rendering acquires no disclosure", () => {
  const bare = renderToStaticMarkup(
    createElement(ProfileFields, {
      draft: emptyJoinProfileDraft(),
      errors: {},
      onChange: () => {},
    }),
  );

  it("renders the fields but no notice and no privacy link", () => {
    expect(bare).toContain('data-testid="waitlist-profile-fields"');
    expect(bare).not.toContain('data-testid="public-collection-notice"');
    expect(bare).not.toContain(PRIVACY_POLICY_PATH);
  });

  it("collects without submitting, so legal copy there would be a FALSE claim", () => {
    // It collects but cannot submit. A disclosure here would assert a practice
    // the reader cannot falsify — worse than an absent one. That is why the
    // rule is "collects BEHIND A SUBMIT", and why this component renders no
    // submit control of any kind.
    expect(bare.match(/<button[^>]*>/g) ?? []).toHaveLength(0);
    expect(bare).not.toContain('type="submit"');
    expect(sourceOf("components/waitlist/profile-fields.tsx")).not.toContain(
      "PublicCollectionSubmit",
    );
  });
});

describe("dormant presentation is not described as active production collection", () => {
  /** Bounded to one question about THIS tree: is any of it reachable today? */
  function walkFiles(dir: string, ext: ReadonlyArray<string>): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, ext));
      else if (ext.some((e) => abs.endsWith(e))) out.push(abs);
    }
    return out;
  }

  it("no WAIT-04 surface is reachable from a route", () => {
    const referencing = walkFiles(path.join(process.cwd(), "app"), [".ts", ".tsx"]).filter(
      (f) => readFileSync(f, "utf8").includes("components/waitlist"),
    );
    expect(referencing).toEqual([]);
  });

  it("the live Privacy Policy does NOT yet describe the WAIT-04 categories", () => {
    const policy = readFileSync(path.join(process.cwd(), "app/privacy/page.tsx"), "utf8");
    for (const premature of [
      "treatment areas and availability",
      "availability preference",
      "sms_consent_at",
    ]) {
      expect(policy).not.toContain(premature);
    }
  });

  it("the obligation to update it atomically is RECORDED", () => {
    const contract = readFileSync(
      path.join(process.cwd(), "lib/waitlist/profile-binding-contract.ts"),
      "utf8",
    );
    expect(contract).toContain("privacy_policy_describes_activated_collection");
    expect(contract).toMatch(/SAME change that activates collection/i);
  });

  it("the notice claims no present-tense production practice", () => {
    expect(JOIN_COLLECTION_NOTICE).not.toMatch(/we (already|currently) (store|collect)/i);
  });
});
