import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import { ProfileFields } from "@/components/waitlist/profile-fields";
import { emptyJoinProfileDraft } from "@/lib/waitlist/join-profile";
import {
  JOIN_COLLECTION_NOTICE,
  PRIVACY_POLICY_PATH,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// THE DISCLOSURE-SURFACE DRIFT GUARD — STRUCTURAL
// ===========================================================================
//
// THE INVARIANT: every public profile-collection SUBMISSION surface renders the
// same point-of-collection disclosure, adjacent to its submission action, from
// one owner.
//
// WHY THIS FILE PARSES INSTEAD OF GREPPING. The previous revision decided
// "can this surface submit?" with `/type="submit"/`. HTML disagrees: a <button>
// inside a <form> with no `type` IS a submit button, by default. So a surface
// written
//
//     <form><ProfileFields …/><button>Save</button></form>
//
// collects behind a real submission control and was never DISCOVERED — it
// escaped the guard entirely, which is the exact escape the dual predicate was
// added to prevent. `<input type="submit">` escaped the same way. The regex
// encoded one spelling of a rule the rule does not have.
//
// That is the same defect shape as the two it was written to catch, one level
// up: a rule stated correctly in prose and implemented more narrowly in code. A
// third spelling would have escaped a third regex, so the predicate is now
// STRUCTURAL — the TypeScript compiler API (already a devDependency; no new
// package) parses each .tsx and answers the question about the syntax tree.
//
// FAIL-SAFE, NOT FAIL-QUIET. A <button> whose `type` is a dynamic expression
// counts as submit-capable, because the guard cannot prove it is not. An
// unparseable file is reported rather than skipped. Every ambiguity resolves
// toward being discovered.
// ===========================================================================

const COMPONENT_DIR = path.join(process.cwd(), "components");
const OWNER = "PublicCollectionSubmit";

function walkFiles(dir: string, ext: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, ext));
    else if (ext.some((e) => abs.endsWith(e))) out.push(abs);
  }
  return out;
}

function parse(abs: string, source: string): ts.SourceFile {
  return ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The tag name of any JSX element node, self-closing or not. */
function tagNameOf(node: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  return null;
}

function attributesOf(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  return null;
}

/**
 * A string-literal attribute value, or `DYNAMIC` when it is an expression.
 * `null` means the attribute is absent.
 */
const DYNAMIC = Symbol("dynamic");
function attrValue(node: ts.Node, name: string): string | typeof DYNAMIC | null {
  const attrs = attributesOf(node);
  if (!attrs) return null;
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue;
    const init = a.initializer;
    if (!init) return "";
    if (ts.isStringLiteral(init)) return init.text;
    return DYNAMIC;
  }
  return null;
}

/** Is this node inside a <form> element? */
function insideForm(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (tagNameOf(p) === "form") return true;
  }
  return false;
}

type SurfaceFacts = {
  rel: string;
  source: string;
  collects: boolean;
  submitKinds: string[];
  ownerCount: number;
};

/**
 * THE ONE VISITOR. Both entry points below delegate here.
 *
 * Deliberately not duplicated: an earlier draft of this file had the walk
 * written out twice — once for files, once for string fixtures — which is the
 * same drift hazard this guard exists to prevent, reproduced inside the guard.
 * The fixtures must exercise the SAME predicate the tree walk uses, or they
 * prove nothing about it.
 */
function analyseSource(name: string, source: string): SurfaceFacts {
  const sf = parse(name, source);
  const facts: SurfaceFacts = {
    rel: name,
    source,
    collects: false,
    submitKinds: [],
    ownerCount: 0,
  };
  const visit = (node: ts.Node): void => {
    const tag = tagNameOf(node);
    if (tag === "ProfileFields") facts.collects = true;
    if (tag === OWNER) {
      facts.ownerCount += 1;
      facts.submitKinds.push("owner");
    }
    if (tag === "input" && attrValue(node, "type") === "submit") {
      facts.submitKinds.push("input-submit");
    }
    if (tag === "button") {
      const type = attrValue(node, "type");
      if (type === "submit") facts.submitKinds.push("button-explicit");
      // HTML DEFAULT: a <button> in a form with no `type` submits it.
      else if (type === null && insideForm(node)) facts.submitKinds.push("button-implicit");
      // A dynamic `type` cannot be proven non-submitting — fail safe.
      else if (type === DYNAMIC) facts.submitKinds.push("button-dynamic");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** File entry point. Same visitor, path-relative name. */
function analyse(abs: string): SurfaceFacts {
  return {
    ...analyseSource(path.relative(process.cwd(), abs), readFileSync(abs, "utf8")),
  };
}

/** Every component that collects profile data behind ANY submission control. */
function discoverCollectionSurfaces(): SurfaceFacts[] {
  return walkFiles(COMPONENT_DIR, [".tsx"])
    .map(analyse)
    .filter((f) => f.collects && f.submitKinds.length > 0);
}

const SURFACES = discoverCollectionSurfaces();
const SURFACE_NAMES = SURFACES.map((s) => s.rel).sort();

describe("the parser answers the HTML question, not one spelling of it", () => {
  // Fixtures proving each submission shape is RECOGNISED. These are parsed
  // strings, not files, so they add no surface to the tree.
  const F = (body: string) =>
    analyseSource("f.tsx", `import { ProfileFields } from "x";\nexport const C = () => (${body});`);

  it("recognises an explicit submit button", () => {
    expect(F(`<form><ProfileFields/><button type="submit">S</button></form>`).submitKinds)
      .toContain("button-explicit");
  });

  it("recognises an IMPLICIT submit button — a <button> in a form", () => {
    // The escape that produced this repair.
    expect(F(`<form><ProfileFields/><button>S</button></form>`).submitKinds)
      .toContain("button-implicit");
  });

  it("recognises <input type=\"submit\">", () => {
    expect(F(`<form><ProfileFields/><input type="submit"/></form>`).submitKinds)
      .toContain("input-submit");
  });

  it("recognises the shared owner", () => {
    expect(F(`<form><ProfileFields/><PublicCollectionSubmit/></form>`).submitKinds)
      .toContain("owner");
  });

  it("treats a DYNAMIC button type as submit-capable — fail safe", () => {
    expect(F(`<form><ProfileFields/><button type={t}>S</button></form>`).submitKinds)
      .toContain("button-dynamic");
  });

  it("does NOT count a type=\"button\" control, nor a button outside any form", () => {
    // NON-VACUITY for the whole predicate: it can say no. A guard that called
    // everything a submission surface would pass every test below for the
    // wrong reason.
    expect(F(`<form><ProfileFields/><button type="button">S</button></form>`).submitKinds)
      .toEqual([]);
    expect(F(`<div><ProfileFields/><button>S</button></div>`).submitKinds).toEqual([]);
  });

  it("detects the collector independently of the control", () => {
    expect(F(`<form><ProfileFields/><button>S</button></form>`).collects).toBe(true);
    expect(
      analyseSource("g.tsx", `export const C = () => (<form><button>S</button></form>);`).collects,
    ).toBe(false);
  });
});

describe("the walker finds a real, non-empty surface set", () => {
  // ANTI-VACUITY. A walker that discovers nothing makes every per-surface
  // assertion below pass against an empty set — green precisely because it is
  // looking at nothing. This caught exactly that on the guard's first run.
  it("discovers at least the two known collection surfaces", () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
  });

  it("discovers exactly the surfaces that exist today", () => {
    expect(SURFACE_NAMES).toEqual([
      "components/waitlist/complete-profile-panel.tsx",
      "components/waitlist/waitlist-join-form.tsx",
    ]);
  });

  it("reads real files rather than matching paths", () => {
    for (const s of SURFACES) expect(s.source.length).toBeGreaterThan(500);
  });
});

describe("EXACTLY ONE owner on every discovered surface", () => {
  for (const surface of SURFACES) {
    describe(surface.rel, () => {
      it("renders the owner exactly once — not zero, not twice", () => {
        // Zero: a CTA with no notice, the original defect.
        // Two: two CTAs, or one CTA and a stray duplicate disclosure.
        expect(surface.ownerCount).toBe(1);
      });

      it("has NO submission control other than the owner", () => {
        // Any other kind means a second path to submit, which by definition is
        // a path that does not carry the disclosure.
        expect(surface.submitKinds).toEqual(["owner"]);
      });

      it("imports the owner it renders", () => {
        expect(surface.source).toContain(
          'from "@/components/waitlist/public-collection-submit"',
        );
      });

      it("holds no second local disclosure copy", () => {
        // One owner, one string. The Privacy Policy destination is therefore
        // INHERITED rather than restated, which is why removing it from the
        // owner breaks every surface at once.
        expect(surface.source).not.toContain("JOIN_COLLECTION_NOTICE");
        expect(surface.source).not.toContain(PRIVACY_POLICY_PATH);
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

// Render fixtures need per-surface props, so they cannot be fully derived. The
// list is therefore BOUND to the discovered set by the assertion below: adding a
// surface without a fixture fails, so this cannot silently drift out of step
// with what the walker finds.
const RENDERED: Array<{ rel: string; html: string }> = [
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
];

describe("the render fixtures cannot drift from the discovered set", () => {
  it("covers every discovered surface, and nothing that is not one", () => {
    expect(RENDERED.map((r) => r.rel).sort()).toEqual(SURFACE_NAMES);
  });
});

describe("every surface RENDERS the disclosure, adjacent to its submit", () => {
  for (const { rel, html } of RENDERED) {
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

  it("and is not itself a discovered surface", () => {
    // It collects but cannot submit, so legal copy there would be a FALSE
    // disclosure — worse than an absent one, because the reader cannot falsify
    // it. That is why the rule is "collects BEHIND A SUBMIT".
    expect(SURFACE_NAMES).not.toContain("components/waitlist/profile-fields.tsx");
    expect(analyse(path.join(COMPONENT_DIR, "waitlist/profile-fields.tsx")).submitKinds)
      .toEqual([]);
  });
});

describe("dormant presentation is not described as active production collection", () => {
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
