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

/**
 * The exact contents of ONE element, found by balanced-tag depth.
 *
 * WHY NOT A FLAT REGEX. The previous revision asked "does the notice appear
 * somewhere after the owner's opening tag?" with `[\s\S]*?`, and that question
 * is not the contract. A lazy wildcard crosses the owner's own `</div>`, so a
 * component that closed its container after the button and rendered the notice
 * as a SIBLING satisfied every assertion while breaking the stated adjacency.
 * Proven against the regex directly: both the nested and the sibling shape
 * matched, and both contained `type="submit"`.
 *
 * So containment is decided by DEPTH instead. This walks forward from the
 * opening tag counting nesting, and returns only what lies inside the matching
 * close — no DOM library is available in this `node` environment, and adding
 * one is a package change this repair may not make.
 *
 * Bounded on purpose: it reads ONE named element out of ONE rendered string. It
 * resolves no components, discovers no surfaces, and knows nothing about any
 * file. The retired future-surface walker is not coming back through here.
 *
 * Returns null when the element is absent OR its tags are unbalanced — both
 * fail the assertions rather than passing quietly.
 */
function elementContents(html: string, tag: string, testId: string): string | null {
  const open = new RegExp(`<${tag}[^>]*data-testid="${testId}"[^>]*>`);
  const found = html.match(open);
  if (!found || found.index === undefined) return null;
  const start = found.index + found[0].length;
  const scanner = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "g");
  scanner.lastIndex = start;
  let depth = 1;
  let step: RegExpExecArray | null;
  while ((step = scanner.exec(html)) !== null) {
    if (step[2] === "/") continue; // self-closing, opens nothing
    depth += step[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, step.index);
  }
  return null; // unbalanced — fail closed
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

      it("the submit control and the notice are INSIDE the same owner container", () => {
        // Structural containment, not proximity in a string.
        const owner = elementContents(html, "div", "public-collection-submit");
        expect(owner, "the owner container must be present and balanced").not.toBeNull();
        expect(owner!).toContain('type="submit"');
        expect(owner!).toContain('data-testid="public-collection-notice"');
      });

      it("the Privacy Policy link sits inside the DISCLOSURE region itself", () => {
        // Not merely inside the owner: inside the notice. A link beside the
        // notice rather than within it would read as an unrelated control.
        const owner = elementContents(html, "div", "public-collection-submit");
        const notice = elementContents(owner ?? "", "p", "public-collection-notice");
        expect(notice, "the notice must be present and balanced").not.toBeNull();
        expect(notice!).toContain(`href="${PRIVACY_POLICY_PATH}"`);
        expect(notice!).toContain("Privacy Policy");
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

describe("the adjacency check itself refuses the shapes that broke it", () => {
  // PERMANENT negative controls, not a one-off mutation. Each fixture is the
  // rendered SHAPE a future edit to PublicCollectionSubmit could produce, and
  // the checker must reject it here rather than in a review nobody runs twice.
  const BUTTON = '<button type="submit">Join</button>';
  const NOTICE =
    '<p data-testid="public-collection-notice">We share this with ' +
    '<a href="/privacy">Privacy Policy</a></p>';

  const NESTED = `<div data-testid="public-collection-submit">${BUTTON}${NOTICE}</div>`;
  const SIBLING = `<div data-testid="public-collection-submit">${BUTTON}</div>${NOTICE}`;
  const REMOVED = `<div data-testid="public-collection-submit">${BUTTON}</div>`;
  const DUPLICATED = `<div data-testid="public-collection-submit">${BUTTON}${NOTICE}${NOTICE}</div>`;
  const WRAPPED = `<div data-testid="public-collection-submit">${BUTTON}<div class="x">${NOTICE}</div></div>`;

  const ownerOf = (html: string) => elementContents(html, "div", "public-collection-submit");

  it("ACCEPTS the shape that ships today", () => {
    // The control. Without it, a checker that rejected everything would pass
    // every assertion below.
    expect(ownerOf(NESTED)).toContain('data-testid="public-collection-notice"');
    expect(ownerOf(NESTED)).toContain('type="submit"');
  });

  it("accepts a notice nested DEEPER inside the owner", () => {
    // Containment, not immediate childhood — a layout wrapper is legitimate.
    expect(ownerOf(WRAPPED)).toContain('data-testid="public-collection-notice"');
  });

  it("REJECTS the notice moved outside the owner container", () => {
    // The exact escape the flat regex allowed: container closed after the
    // button, notice rendered as a sibling.
    expect(ownerOf(SIBLING)).not.toContain('data-testid="public-collection-notice"');
    expect(ownerOf(SIBLING)).toContain('type="submit"');
  });

  it("REJECTS a removed notice", () => {
    expect(ownerOf(REMOVED)).not.toContain('data-testid="public-collection-notice"');
  });

  it("REJECTS a duplicated notice", () => {
    const owner = ownerOf(DUPLICATED) ?? "";
    expect(owner.match(/data-testid="public-collection-notice"/g) ?? []).toHaveLength(2);
    // Which is what the per-surface EXACTLY ONCE assertion rejects.
    expect(DUPLICATED.match(/data-testid="public-collection-notice"/g) ?? []).toHaveLength(2);
  });

  it("fails closed on an absent or unbalanced container", () => {
    expect(ownerOf("<p>nothing here</p>")).toBeNull();
    expect(ownerOf(`<div data-testid="public-collection-submit">${BUTTON}`)).toBeNull();
  });
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
    // WAIT INTEGRATION-01 — NARROWED FROM THE DIRECTORY TO THE WAIT-04 FILES,
    // and narrowed is the operative word: this now forbids more PRECISELY, not
    // less.
    //
    // `components/waitlist/` holds two unrelated slices. WAIT-04A's join and
    // profile surfaces live there, and so does WAIT-03 B4's invite composer.
    // Matching the directory meant the guard fired on either, so binding B4 —
    // which the assembly does deliberately, and which collects no treatment
    // area, availability or SMS consent whatsoever — read as activating WAIT-04.
    //
    // THE INVARIANT THAT MATTERS IS UNCHANGED AND STILL ENFORCED: no route may
    // reach a WAIT-04 COLLECTION surface, because none of that collection is
    // built, disclosed in the privacy policy, or authorised. The five files are
    // named explicitly, so adding a sixth WAIT-04 component and wiring it to a
    // route still fails here.
    const WAIT_04_SURFACES = [
      "components/waitlist/waitlist-join-form",
      "components/waitlist/complete-profile-panel",
      "components/waitlist/profile-fields",
      "components/waitlist/public-collection-submit",
      "components/waitlist/treatment-area-picker",
    ];
    const referencing = walkFiles(path.join(process.cwd(), "app"), [".ts", ".tsx"]).filter((f) => {
      const src = readFileSync(f, "utf8");
      return WAIT_04_SURFACES.some((surface) => src.includes(surface));
    });
    expect(referencing).toEqual([]);

    // NON-VACUITY: every named file must exist, or this guard is watching for
    // imports of nothing and would pass however WAIT-04 were activated.
    for (const surface of WAIT_04_SURFACES) {
      expect(
        readFileSync(path.join(process.cwd(), `${surface}.tsx`), "utf8").length,
        `${surface} no longer exists — the WAIT-04 guard list is stale`,
      ).toBeGreaterThan(0);
    }
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
