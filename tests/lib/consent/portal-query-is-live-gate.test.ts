import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #167. The portal-facing query in lib/consent/queries.ts must
// require is_live = true in addition to status = 'active'. The
// DB CHECK constraint makes the second clause structurally
// redundant, but the application keeps both filters as defense-
// in-depth: if a future migration accidentally drops the CHECK,
// the explicit clause keeps draft legal text off the wire. These
// source-grep tests pin both filters and the negative (no
// missing-filter regression).

const QUERIES_PATH = path.resolve(
  __dirname,
  "../../../lib/consent/queries.ts",
);
const QUERIES = readFileSync(QUERIES_PATH, "utf8");

const PORTAL_PAY_PATH = path.resolve(
  __dirname,
  "../../../app/portal/payment-method-actions.ts",
);
const PORTAL_PAY = readFileSync(PORTAL_PAY_PATH, "utf8");

const PORTAL_CONSENT_PATH = path.resolve(
  __dirname,
  "../../../app/portal/consent-actions.ts",
);
const PORTAL_CONSENT = readFileSync(PORTAL_CONSENT_PATH, "utf8");

const SIGN_CORE_PATH = path.resolve(
  __dirname,
  "../../../lib/consent/sign-consent-form.ts",
);
const SIGN_CORE = readFileSync(SIGN_CORE_PATH, "utf8");

const PORTAL_PAGE = readFileSync(
  path.resolve(__dirname, "../../../app/portal/page.tsx"),
  "utf8",
);
const PORTAL_FORMS = readFileSync(
  path.resolve(__dirname, "../../../app/portal/PortalConsentForms.tsx"),
  "utf8",
);
const SNAPSHOT_LIB = readFileSync(
  path.resolve(__dirname, "../../../lib/consent/template-snapshot.ts"),
  "utf8",
);

describe("portal-facing consent query (lib/consent/queries.ts)", () => {
  it("getActiveConsentTemplatesForPortal filters by is_live = true", () => {
    // Pin the exact .eq call so a refactor to .filter() or .gt()
    // or any other expression that loses the literal boolean
    // comparison is caught.
    const fn =
      QUERIES.match(
        /export async function getActiveConsentTemplatesForPortal[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/\.eq\("is_live",\s*true\)/);
  });

  it("getActiveConsentTemplatesForPortal still filters by status = 'active'", () => {
    // Defense-in-depth: keep the status clause even though the
    // CHECK makes it redundant. A future PR that drops one
    // clause needs to be a deliberate choice, not an accident.
    const fn =
      QUERIES.match(
        /export async function getActiveConsentTemplatesForPortal[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/\.eq\("status",\s*"active"\)/);
  });

  it("the portal query selects only safe-for-portal columns (no status, no is_live, no created_by)", () => {
    // The portal page does not need to know practitioner-side
    // status or who created the template; pinning the projection
    // catches an accidental .select("*") regression.
    const fn =
      QUERIES.match(
        /export async function getActiveConsentTemplatesForPortal[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(
      /\.select\("id, title, description, body, form_type, version"\)/,
    );
    expect(fn).not.toMatch(/\.select\(.*status.*\)/);
    expect(fn).not.toMatch(/\.select\("\*"\)/);
  });

  it("getConsentTemplatesForStudio (practitioner side) does NOT filter by is_live", () => {
    // The Settings UI must see every template so the owner can
    // see drafts they are working on. Filtering by is_live would
    // hide the drafts.
    const fn =
      QUERIES.match(
        /export async function getConsentTemplatesForStudio[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).not.toMatch(/\.eq\("is_live"/);
    expect(fn).not.toMatch(/\.eq\("status"/);
  });
});

describe("portal Add Card flow (app/portal/payment-method-actions.ts via shared helper)", () => {
  // PR #170 moved the card_authorization template + signature
  // lookups into lib/consent/current-card-authorization.ts. The
  // PR #167 is_live=true requirement is now enforced in the
  // helper. These tests verify the helper carries the predicates
  // and that the action delegates to it.
  const CARD_AUTH_HELPER_PATH = path.resolve(
    __dirname,
    "../../../lib/consent/current-card-authorization.ts",
  );
  const CARD_AUTH_HELPER = readFileSync(CARD_AUTH_HELPER_PATH, "utf8");

  it("the shared helper requires is_live = true on the card_authorization template lookup", () => {
    expect(CARD_AUTH_HELPER).toMatch(/\.eq\("is_live",\s*true\)/);
  });

  it("the shared helper still requires status='active' and form_type='card_authorization'", () => {
    expect(CARD_AUTH_HELPER).toMatch(/\.eq\("status",\s*"active"\)/);
    expect(CARD_AUTH_HELPER).toMatch(
      /\.eq\("form_type",\s*"card_authorization"\)/,
    );
  });

  it("the SetupIntent action delegates to the helper", () => {
    expect(PORTAL_PAY).toMatch(/getCardAuthorizationStatus/);
  });
});

// The signing ceremony moved out of the portal action into the shared core
// (lib/consent/sign-consent-form.ts) so the intake surface can reuse ONE
// implementation. These pins follow the code to its new home rather than
// being weakened -- and a second pin below keeps the wrapper honest, so a
// future edit that re-introduces a private lookup in the portal action is
// still caught.
describe("shared signing core (lib/consent/sign-consent-form.ts)", () => {
  it("the per-template lookup before signing requires is_live = true", () => {
    expect(SIGN_CORE).toMatch(/\.eq\("is_live",\s*true\)/);
  });

  it("the lookup still requires status='active'", () => {
    expect(SIGN_CORE).toMatch(/\.eq\("status",\s*"active"\)/);
  });

  it("BOTH server lookups are scoped to the caller-resolved studio", () => {
    // The core runs two studio-scoped lookups: the clients re-check and the
    // template lookup. A single .toMatch is satisfied by EITHER, so deleting
    // one leaves the pin green -- verified by mutation. Count them instead.
    const scoped =
      SIGN_CORE.match(/\.eq\("studio_id",\s*identity\.studioId\)/g) ?? [];
    expect(scoped).toHaveLength(2);
  });

  it("the clients re-check gates on archived_at before any write", () => {
    expect(SIGN_CORE).toMatch(/from\("clients"\)/);
    expect(SIGN_CORE).toMatch(/client\.archived_at != null/);
  });
});

// The render surface is the other half of the integrity comparison, and the
// unit lane cannot reach it: every behavioural test builds its own FormData,
// so deleting the `fd.set("rendered_template_hash", ...)` line left the whole
// suite green (negative control 10). These pins are that missing oracle --
// deliberately a supplement to the behavioural tests, never a substitute.
describe("the render surface supplies the comparand", () => {
  it("the portal page derives the hash server-side with the canonical helper", () => {
    expect(PORTAL_PAGE).toMatch(
      /import \{ withRenderedTemplateHash \} from "@\/lib\/consent\/template-snapshot"/,
    );
    expect(PORTAL_PAGE).toMatch(/\.map\(\s*withRenderedTemplateHash,?\s*\)/);
  });

  it("the sign form posts BOTH comparands back", () => {
    // Both, deliberately. Pinning only the hash left deleting the form_type
    // line completely green (negative control 12) -- the same blind spot the
    // hash pin was added to close.
    expect(PORTAL_FORMS).toMatch(
      /fd\.set\("rendered_template_hash",\s*template\.renderedTemplateHash\)/,
    );
    expect(PORTAL_FORMS).toMatch(
      /fd\.set\("rendered_form_type",\s*template\.form_type\)/,
    );
  });

  it("the wrapper forwards BOTH comparands to the core", () => {
    expect(PORTAL_CONSENT).toMatch(/formData\.get\("rendered_template_hash"\)/);
    expect(PORTAL_CONSENT).toMatch(/formData\.get\("rendered_form_type"\)/);
    expect(PORTAL_CONSENT).toMatch(/renderedTemplateHash,/);
    expect(PORTAL_CONSENT).toMatch(/renderedFormType,/);
  });

  it("the render helper routes through buildConsentTemplateSnapshot", () => {
    // A second, separately-derived hash here would make the comparison
    // silently vacuous the moment either side drifted.
    expect(SNAPSHOT_LIB).toMatch(
      /export function withRenderedTemplateHash[\s\S]{0,400}buildConsentTemplateSnapshot\(template\)\.templateHash/,
    );
  });
});

describe("portal sign action (app/portal/consent-actions.ts)", () => {
  it("delegates the ceremony to the shared core", () => {
    expect(PORTAL_CONSENT).toMatch(
      /import \{ recordConsentSignature \} from "@\/lib\/consent\/sign-consent-form"/,
    );
    expect(PORTAL_CONSENT).toMatch(/await recordConsentSignature\(\{/);
  });

  it("runs NO consent_form_templates lookup of its own", () => {
    // A private lookup here would be a second ceremony: the whole point of
    // the extraction is that the four-clause gate exists exactly once.
    expect(PORTAL_CONSENT).not.toMatch(/from\("consent_form_templates"\)/);
    expect(PORTAL_CONSENT).not.toMatch(/from\("client_consent_signatures"\)/);
  });

  it("passes NO allowedFormTypes, so the portal still signs every live type", () => {
    // The portal deliberately signs card_authorization too. Narrowing here
    // would silently change shipped portal behaviour.
    expect(PORTAL_CONSENT).not.toMatch(/allowedFormTypes/);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-09. Photo consent moved OUT of the intake and is now collected only
// in the client portal, which makes two more helpers portal-eligibility
// claims, and both must use the same boundary as the portal itself.
//
// `status = 'active'` alone is not portal visibility: migration 0072's CHECK
// (NOT is_live OR status='active') still permits active + is_live=false, a
// form the owner activated and deliberately hid. Telling a practitioner such a
// form is "not completed" blames the client for something they cannot reach.
describe("practitioner-facing photo-consent status uses the PORTAL boundary", () => {
  const photoView =
    QUERIES.match(
      /export async function getPortalPhotoConsentsForPractitionerView[\s\S]*?\n\}/,
    )?.[0] ?? "";
  const imagesState =
    QUERIES.match(
      /export async function getPhotoConsentStateForClient[\s\S]*?\n\}/,
    )?.[0] ?? "";

  it("the View-intake portal status filters is_live = true", () => {
    expect(photoView).not.toBe("");
    expect(photoView).toMatch(/\.eq\("is_live",\s*true\)/);
    expect(photoView).toMatch(/\.eq\("status",\s*"active"\)/);
  });

  it("the Treatment-Images photo status filters is_live = true", () => {
    // Shipped in #405 filtering on status alone, which predates the
    // portal-collection contract.
    expect(imagesState).not.toBe("");
    expect(imagesState).toMatch(/\.eq\("is_live",\s*true\)/);
    expect(imagesState).toMatch(/\.eq\("status",\s*"active"\)/);
  });

  it("the View-intake status does NOT collapse live forms with limit(1)", () => {
    // One row per live photo template. A `.limit(1)` here would silently drop
    // a real consent record.
    expect(photoView).not.toMatch(/\.limit\(1\)/);
    expect(photoView).not.toMatch(/maybeSingle\(\)/);
  });

  it("it orders templates like the portal does, not by version", () => {
    // created_at ASC, matching getActiveConsentTemplatesForPortal. Ordering by
    // version across DIFFERENT templates would imply a ranking between them.
    expect(photoView).toMatch(/\.order\("created_at",\s*\{\s*ascending:\s*true\s*\}\)/);
  });
});
