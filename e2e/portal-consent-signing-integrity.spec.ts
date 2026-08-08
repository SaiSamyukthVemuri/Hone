import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seedE2eStudio, sql } from "./helpers/seed";

// PR #526. The ONE browser proof for the consent signing chain.
//
// Unit and DB coverage for the stale-form gate is strong, but every unit test
// builds its own FormData, so none of them proves the link that actually
// carries the integrity comparands:
//
//   server renders the template -> browser receives the comparands
//     -> client signs -> server action -> shared core
//     -> client_consent_signatures
//
// Deleting the `fd.set("rendered_template_hash", ...)` line from the real form
// left the entire unit suite green (negative control 10 in the PR). This spec
// is that missing oracle, and it drives the REAL /portal page and the REAL
// server action -- nothing is mocked and nothing is invoked directly.
//
// THE SIGNING ORACLE IS THE DATABASE ROW, NEVER THE SUCCESS COPY. Every
// journey asserts on client_consent_signatures.
//
// Portal auth: the portal is a magic-link realm and the raw link token is
// unrecoverable (hash-only at rest, and the local harness has no inbox for
// it). Rather than build a portal-auth framework in this PR, the spec
// establishes a session with the REAL primitives: mint a raw token, store its
// SHA-256 in client_portal_sessions exactly as createPortalSession does
// (lib/portal/session.ts), and set the same hone_portal_session cookie. The
// app's own getCurrentPortalSession then validates it exactly as it would in
// production -- no auth code is bypassed or stubbed.

const COOKIE_NAME = "hone_portal_session";

const TITLE_V1 = "Treatment consent";
const BODY_V1 =
  "Studio-authored treatment consent, version one. Read this carefully.";
const BODY_V2 =
  "Studio-authored treatment consent, version two. The terms have changed.";

const STALE_MESSAGE =
  "This form changed while you were reviewing it. Please refresh and review the current version before signing.";

const PHOTO_TITLE = "Photo consent";
const PHOTO_BODY = "Studio-authored photo consent text.";
const PHOTO_DENY_LABEL = "I do not consent to photo use.";
const PHOTO_ACCEPT_LABEL = "I consent to photo use as described above.";

// Independent re-derivation of the canonical hash. Deliberately NOT imported
// from lib/consent/template-snapshot.ts: importing the implementation would
// make this assertion agree with itself. The canonical form is the documented
// contract -- <title>\n---\n<body>\n---\n<version> -- and 0057 stores its
// SHA-256 hex.
function canonicalHash(title: string, body: string, version: number): string {
  return createHash("sha256")
    .update(`${title}\n---\n${body}\n---\n${version}`, "utf8")
    .digest("hex");
}

type SignatureRow = {
  studio_id: string;
  client_id: string;
  template_id: string;
  template_title_snapshot: string;
  template_body_snapshot: string;
  template_version: number;
  template_hash: string;
  signature_name: string;
  response: string;
  response_label_snapshot: string | null;
};

async function seedClient(studioId: string): Promise<string> {
  const clientId = randomUUID();
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, studioId, "E2E Consent Client", `consent-${clientId}@harness.local`],
  );
  return clientId;
}

async function seedLiveTemplate(
  studioId: string,
  formType: string,
  title: string,
  body: string,
): Promise<string> {
  const templateId = randomUUID();
  await sql(
    `insert into public.consent_form_templates
       (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,$3,$4,$5,1,'active',true)`,
    [templateId, studioId, title, body, formType],
  );
  return templateId;
}

/** Exactly what updateConsentTemplateAction does: rewrite the content and
 *  bump the version, touching NEITHER status NOR is_live -- which is why the
 *  row stays signable and the race is reachable at all. */
async function studioEditsTemplate(templateId: string, body: string) {
  await sql(
    `update public.consent_form_templates
        set body = $2, version = version + 1
      where id = $1`,
    [templateId, body],
  );
}

/** Establish a portal session using the real primitives (see file header). */
async function establishPortalSession(
  page: Page,
  studioId: string,
  clientId: string,
) {
  const raw = randomBytes(32).toString("base64url");
  await sql(
    `insert into public.client_portal_sessions
       (studio_id, client_id, session_token_hash, expires_at)
     values ($1,$2,$3, now() + interval '7 days')`,
    [studioId, clientId, createHash("sha256").update(raw, "utf8").digest("hex")],
  );
  await page.context().addCookies([
    {
      name: COOKIE_NAME,
      value: raw,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

async function signaturesFor(
  studioId: string,
  clientId: string,
): Promise<SignatureRow[]> {
  return sql<SignatureRow>(
    `select studio_id, client_id, template_id, template_title_snapshot,
            template_body_snapshot, template_version, template_hash,
            signature_name, response, response_label_snapshot
       from public.client_consent_signatures
      where studio_id = $1 and client_id = $2
      order by signed_at asc`,
    [studioId, clientId],
  );
}

/** Open the drawer for a template by its rendered title. */
async function openForm(page: Page, title: string) {
  await page.goto("/portal");
  const card = page.locator("li", { hasText: title }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Review and sign" }).click();
}

test.describe("portal consent signing integrity (real page, real action)", () => {
  test("A: an unchanged treatment consent signs and stores the server-derived snapshot", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId);
    const templateId = await seedLiveTemplate(
      seed.studioId,
      "treatment_consent",
      TITLE_V1,
      BODY_V1,
    );
    await establishPortalSession(page, seed.studioId, clientId);

    await openForm(page, TITLE_V1);
    // The studio-authored body must actually be on screen -- this is the text
    // the signature will attest to.
    await expect(page.getByText(BODY_V1)).toBeVisible();

    await page.getByLabel("Type your full name to sign").fill("Jane Client");
    await page
      .getByRole("checkbox", { name: "I have read and agree to this form." })
      .check();
    await page.getByRole("button", { name: "Sign form" }).click();

    // ORACLE: the database row, not the success copy.
    await expect
      .poll(async () => (await signaturesFor(seed.studioId, clientId)).length)
      .toBe(1);

    const [row] = await signaturesFor(seed.studioId, clientId);
    expect(row.studio_id).toBe(seed.studioId);
    expect(row.client_id).toBe(clientId);
    expect(row.template_id).toBe(templateId);
    expect(row.template_version).toBe(1);
    expect(row.template_title_snapshot).toBe(TITLE_V1);
    expect(row.template_body_snapshot).toBe(BODY_V1);
    expect(row.template_hash).toBe(canonicalHash(TITLE_V1, BODY_V1, 1));
    expect(row.signature_name).toBe("Jane Client");
  });

  test("B: a form edited after render is REFUSED, writes nothing, and signs correctly after refresh", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId);
    const templateId = await seedLiveTemplate(
      seed.studioId,
      "treatment_consent",
      TITLE_V1,
      BODY_V1,
    );
    await establishPortalSession(page, seed.studioId, clientId);

    // 1. Render version 1 and confirm the browser really has the old text.
    await openForm(page, TITLE_V1);
    await expect(page.getByText(BODY_V1)).toBeVisible();

    // 2. ONLY NOW does the studio edit it. Ordering is the whole point of this
    //    journey: the browser must be holding v1's comparands already.
    await studioEditsTemplate(templateId, BODY_V2);

    // 3. Submit WITHOUT refreshing.
    await page.getByLabel("Type your full name to sign").fill("Jane Client");
    await page
      .getByRole("checkbox", { name: "I have read and agree to this form." })
      .check();
    await page.getByRole("button", { name: "Sign form" }).click();

    // The client sees the approved refusal copy, exactly.
    await expect(page.getByText(STALE_MESSAGE)).toBeVisible();

    // ORACLE: the stale attempt wrote nothing at all.
    expect(await signaturesFor(seed.studioId, clientId)).toHaveLength(0);

    // 4. Refresh: the new version renders...
    await openForm(page, TITLE_V1);
    await expect(page.getByText(BODY_V2)).toBeVisible();
    await expect(page.getByText(BODY_V1)).toHaveCount(0);

    // ...and signing now succeeds.
    await page.getByLabel("Type your full name to sign").fill("Jane Client");
    await page
      .getByRole("checkbox", { name: "I have read and agree to this form." })
      .check();
    await page.getByRole("button", { name: "Sign form" }).click();

    await expect
      .poll(async () => (await signaturesFor(seed.studioId, clientId)).length)
      .toBe(1);

    // ORACLE: the stored snapshot is the text the client ACTUALLY reviewed
    // after refreshing -- v2 -- not v1 and not a mixture.
    const [row] = await signaturesFor(seed.studioId, clientId);
    expect(row.template_version).toBe(2);
    expect(row.template_body_snapshot).toBe(BODY_V2);
    expect(row.template_hash).toBe(canonicalHash(TITLE_V1, BODY_V2, 2));
  });

  test("C: an explicit photo DENY is stored as a denial with the server-owned label", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId);
    await seedLiveTemplate(
      seed.studioId,
      "photo_consent",
      PHOTO_TITLE,
      PHOTO_BODY,
    );
    await establishPortalSession(page, seed.studioId, clientId);

    await openForm(page, PHOTO_TITLE);
    await expect(page.getByText(PHOTO_BODY)).toBeVisible();

    await page.getByRole("radio", { name: PHOTO_DENY_LABEL }).check();
    await page.getByLabel("Type your full name to sign").fill("Jane Client");
    await page
      .getByRole("checkbox", { name: "I have read and agree to this form." })
      .check();
    await page.getByRole("button", { name: "Submit response" }).click();

    await expect
      .poll(async () => (await signaturesFor(seed.studioId, clientId)).length)
      .toBe(1);

    // ORACLE: a denial is a real, recorded signature -- and it stays a denial.
    const [row] = await signaturesFor(seed.studioId, clientId);
    expect(row.response).toBe("denied");
    expect(row.response_label_snapshot).toBe(PHOTO_DENY_LABEL);
    expect(row.response_label_snapshot).not.toBe(PHOTO_ACCEPT_LABEL);
    expect(row.signature_name).toBe("Jane Client");
  });
});
