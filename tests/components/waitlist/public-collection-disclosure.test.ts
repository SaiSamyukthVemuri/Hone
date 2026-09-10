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
// THE DISCLOSURE-SURFACE DRIFT GUARD
// ===========================================================================
//
// Two reviews found the same missing public collection disclosure on two
// sibling surfaces. The guard below exists because a test naming
// `WaitlistJoinForm` and `CompleteProfilePanel` would have caught neither: the
// second surface was invisible to a check written for the first.
//
// So it ENUMERATES the surface set from the source tree rather than from a list
// of names:
//
//     a PUBLIC COLLECTION SURFACE is a component that imports ProfileFields
//     AND renders a submission control.
//
// and asserts the disclosure contract on every member it discovers. A third
// surface added tomorrow is discovered, not overlooked.
//
// THE RULE IS "ProfileFields BEHIND A SUBMIT", NOT "ProfileFields". That
// distinction is load-bearing: `ProfileFields` renders no submit control, so it
// is reusable where nothing is collected — a review step, an operator read-back
// — and legal copy there would be a FALSE disclosure, which is worse than an
// absent one because the reader cannot falsify it.
// ===========================================================================

const COMPONENT_DIR = path.join(process.cwd(), "components");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith(".tsx")) out.push(abs);
  }
  return out;
}

/** Every component that collects profile data behind a submission control. */
function discoverCollectionSurfaces(): Array<{ rel: string; source: string }> {
  const found: Array<{ rel: string; source: string }> = [];
  for (const abs of walk(COMPONENT_DIR)) {
    const source = readFileSync(abs, "utf8");
    const collects = /from "@\/components\/waitlist\/profile-fields"/.test(source);
    // A SUBMISSION CONTROL BY EITHER ROUTE. After this repair the control lives
    // in the owner primitive, so a predicate looking only for `type="submit"`
    // discovers nothing — which the anti-vacuity assertion below caught on the
    // first run of this guard, and is precisely why that assertion exists.
    //
    // Both forms are matched on purpose: a future surface that hand-rolls its
    // own button must still be DISCOVERED, so that the "does not hand-roll"
    // assertion can then fail it. A predicate that only recognised the owner
    // would let a bypassing surface escape the guard entirely.
    const submits =
      /type="submit"/.test(source) || /<PublicCollectionSubmit/.test(source);
    if (collects && submits) {
      found.push({ rel: path.relative(process.cwd(), abs), source });
    }
  }
  return found;
}

const SURFACES = discoverCollectionSurfaces();

describe("the walker finds a real, non-empty surface set", () => {
  // ANTI-VACUITY, AND IT IS THE MOST IMPORTANT TEST IN THIS FILE. A walker that
  // silently discovers nothing makes every per-surface assertion below pass
  // trivially — a guard that is green precisely because it is looking at an
  // empty set. Breaking the glob must turn THIS red.
  it("discovers at least the two known collection surfaces", () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
  });

  it("discovers exactly the surfaces we expect today", () => {
    // If this grows, a new public collection surface exists and every assertion
    // below now applies to it. That is the intended failure: it demands the new
    // surface be reviewed, not that the list be edited to silence it.
    expect(SURFACES.map((s) => s.rel).sort()).toEqual([
      "components/waitlist/complete-profile-panel.tsx",
      "components/waitlist/waitlist-join-form.tsx",
    ]);
  });

  it("the walker actually reads files, rather than matching paths", () => {
    for (const s of SURFACES) expect(s.source.length).toBeGreaterThan(500);
  });
});

describe("every discovered surface routes its submit through the disclosure owner", () => {
  for (const surface of SURFACES) {
    describe(surface.rel, () => {
      it("imports the shared owner", () => {
        expect(surface.source).toContain(
          'from "@/components/waitlist/public-collection-submit"',
        );
        expect(surface.source).toContain("<PublicCollectionSubmit");
      });

      it("does NOT hand-roll its own submit control", () => {
        // The bypass this forbids: a surface that keeps its own <button
        // type="submit"> is a surface that can render a CTA with no notice,
        // which is exactly how the second defect arose.
        expect(surface.source).not.toMatch(/<button\s+type="submit"/);
      });

      it("does NOT hand-roll its own disclosure copy", () => {
        // One owner, one string. A second copy is a second thing to forget.
        expect(surface.source).not.toContain("JOIN_COLLECTION_NOTICE");
        expect(surface.source).not.toContain("/privacy");
        expect(surface.source).not.toContain("Privacy Policy");
      });
    });
  }
});

/** Tags stripped, entities decoded — copy compared as a reader sees it. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const RENDERED: Array<{ name: string; html: string }> = [
  {
    name: "WaitlistJoinForm",
    html: renderToStaticMarkup(
      createElement(WaitlistJoinForm, {
        studioName: "Willow",
        onSubmit: async () => ({ ok: true }) as const,
      }),
    ),
  },
  {
    name: "CompleteProfilePanel",
    html: renderToStaticMarkup(
      createElement(CompleteProfilePanel, {
        studioName: "Willow",
        stored: { legacyName: "Sarah Jones", email: "sarah@example.com" },
        onSubmit: async () => ({ ok: true }) as const,
      }),
    ),
  },
];

describe("every surface RENDERS the disclosure, adjacent to its submit", () => {
  for (const { name, html } of RENDERED) {
    describe(name, () => {
      const text = visibleText(html);

      it("renders the notice, naming the studio", () => {
        expect(html).toContain('data-testid="public-collection-notice"');
        expect(text).toContain(JOIN_COLLECTION_NOTICE);
        expect(text).toContain("Willow and Hone");
      });

      it("renders a real Privacy Policy anchor", () => {
        expect(html).toContain('data-testid="public-collection-privacy-link"');
        expect(html).toMatch(
          new RegExp(`<a[^>]*href="${PRIVACY_POLICY_PATH}"[^>]*>\\s*Privacy Policy\\s*</a>`),
        );
      });

      it("the notice sits inside the same block as the submit control", () => {
        // ADJACENCY, not merely co-presence: both must be inside the owner's
        // wrapper, so the notice cannot drift to a footer.
        const block =
          html.match(
            /<div[^>]*data-testid="public-collection-submit"[\s\S]*?data-testid="public-collection-notice"[\s\S]*?<\/p>/,
          ) ?? [];
        expect(block.length).toBeGreaterThan(0);
        expect(block[0]).toContain('type="submit"');
      });

      it("renders the notice EXACTLY ONCE", () => {
        // Double rendering would mean a surface kept its own copy alongside the
        // owner's — the drift this repair removes, reappearing additively.
        expect((html.match(/data-testid="public-collection-notice"/g) ?? [])).toHaveLength(1);
        expect((html.match(/href="\/privacy"/g) ?? [])).toHaveLength(1);
        expect((html.match(/type="submit"/g) ?? [])).toHaveLength(1);
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
    // A review step or operator read-back collects nothing; claiming otherwise
    // would be a false disclosure.
    expect(bare).toContain('data-testid="waitlist-profile-fields"');
    expect(bare).not.toContain('data-testid="public-collection-notice"');
    expect(bare).not.toContain("/privacy");
  });

  it("and renders no submit control, which is why the rule is conditional", () => {
    expect(bare).not.toContain('type="submit"');
  });
});

describe("dormant presentation is not described as active production collection", () => {
  it("no WAIT-04 surface is reachable from a route", () => {
    // Both components are unwired; `app/` references neither.
    const app = walkAll(path.join(process.cwd(), "app"));
    const referencing = app.filter((f) =>
      readFileSync(f, "utf8").includes("components/waitlist"),
    );
    expect(referencing).toEqual([]);
  });

  it("the live Privacy Policy does NOT yet describe the WAIT-04 categories", () => {
    // A policy describing collection nobody performs is false in the other
    // direction. Both become true together, in WAIT-04B.
    const policy = readFileSync(
      path.join(process.cwd(), "app/privacy/page.tsx"),
      "utf8",
    );
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

function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkAll(abs));
    else if (abs.endsWith(".tsx") || abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}
