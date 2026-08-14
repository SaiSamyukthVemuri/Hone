import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  ClientConsentSignature,
  ClientConsentSignatureResponse,
  ConsentFormTemplate,
} from "@/lib/types/database";
import { consentRowState, type ConsentRowState } from "./signature-status";

// PR #134. Shared read-side queries for consent templates and
// signatures. Every function is scoped by an explicit studioId
// (and clientId where applicable) so callers MUST resolve the
// studio from getCurrentPractitionerWithStudio() (practitioner
// side) or getCurrentPortalSession() (portal side) before passing
// it in; no function here accepts a slug, email, or other client-
// supplied lookup key.

// Practitioner-facing template row. Renders the title + description
// + form_type + status badge + a body preview on the settings
// surface. Excludes nothing; the table is small enough that
// projection optimisation isn't worth the duplication.
export type ConsentFormTemplateForPractitioner = ConsentFormTemplate;

export async function getConsentTemplatesForStudio(
  studioId: string,
): Promise<ConsentFormTemplateForPractitioner[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("consent_form_templates")
    .select("*")
    .eq("studio_id", studioId)
    .order("status", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_templates_for_studio_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as ConsentFormTemplateForPractitioner[];
}

// Portal-facing template view. PR #167 added the explicit is_live
// gate; before this PR the portal read every status='active' row
// directly, which meant the moment a practitioner activated a
// template for their own workflow it landed in the client portal.
// Now the portal requires is_live = true AND status = 'active' --
// the second clause is structurally redundant given the CHECK
// constraint installed in migration 0072 (NOT is_live OR status
// = 'active'), but we keep it for defense-in-depth so a future
// migration that drops or weakens the CHECK does not silently
// re-expose draft text. The portal-side render scopes by the
// session studioId; this function never accepts a slug or other
// client-supplied key.
export type ConsentFormTemplateForPortal = Pick<
  ConsentFormTemplate,
  "id" | "title" | "description" | "body" | "form_type" | "version"
>;

export async function getActiveConsentTemplatesForPortal(
  studioId: string,
): Promise<ConsentFormTemplateForPortal[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("consent_form_templates")
    .select("id, title, description, body, form_type, version")
    .eq("studio_id", studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_templates_for_portal_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as ConsentFormTemplateForPortal[];
}

// Portal-side per-template "have I already signed this template?"
// lookup. Returns the LATEST signature per template_id for the
// resolved (studioId, clientId). The portal page uses this to
// branch between the "Signed" badge + timestamp and the "Review
// and sign" button. Scoped strictly by (studio_id, client_id).
export type PortalSignatureSummary = {
  template_id: string;
  signed_at: string;
  signature_name: string;
  template_version: number;
  response: ClientConsentSignatureResponse;
};

export async function getLatestSignaturesByTemplateForPortal(
  studioId: string,
  clientId: string,
): Promise<Map<string, PortalSignatureSummary>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_consent_signatures")
    .select(
      "template_id, signed_at, signature_name, template_version, response",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("signed_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_signatures_for_portal_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return new Map();
  }
  const map = new Map<string, PortalSignatureSummary>();
  for (const row of data ?? []) {
    const r = row as PortalSignatureSummary;
    // Order-by signed_at desc + first-write-wins gives us latest
    // per template_id in one pass; we deliberately do NOT use
    // distinct on (template_id) because the underlying table
    // index is on (studio_id, client_id, signed_at) and a
    // postgres-side distinct ordering is more work than this.
    if (!map.has(r.template_id)) map.set(r.template_id, r);
  }
  return map;
}

// Practitioner client-profile read. Returns the LATEST signature
// per template the client has signed (any status), plus the full
// row so the card can render signature name, version, and the
// snapshot text if a future "View signed record" affordance lands.
// Scoped strictly by (studio_id, client_id).
export type PractitionerSignatureSummary = Pick<
  ClientConsentSignature,
  | "id"
  | "template_id"
  | "template_title_snapshot"
  | "template_version"
  | "signature_name"
  | "signed_at"
  | "response"
  // P1-A (signed-consent visibility): the columns that hold the ACTUAL agreed
  // content: the exact form copy the client saw + the human-readable photo
  // response label + the integrity hash + created_at. Stored immutably at sign
  // time (0057/0060) but previously never surfaced to the practitioner, so the
  // practitioner could not open the complete signed record.
  | "template_body_snapshot"
  | "response_label_snapshot"
  | "template_hash"
  | "created_at"
>;

export async function getLatestSignaturesForPractitionerView(
  studioId: string,
  clientId: string,
): Promise<PractitionerSignatureSummary[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_consent_signatures")
    .select(
      "id, template_id, template_title_snapshot, template_version, signature_name, signed_at, response, template_body_snapshot, response_label_snapshot, template_hash, created_at",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("signed_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_signatures_for_practitioner_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  // First-write-wins by template_id over a desc-by-signed_at list
  // gives us latest per template. Preserve the iteration order so
  // the card can render "most recently signed first."
  const seen = new Set<string>();
  const result: PractitionerSignatureSummary[] = [];
  for (const row of data ?? []) {
    const r = row as PractitionerSignatureSummary;
    if (seen.has(r.template_id)) continue;
    seen.add(r.template_id);
    result.push(r);
  }
  return result;
}

// P1-A: the client's photo-consent state, for the at-a-glance summary shown in
// the treatment-image workflow. Returns null when the studio has no active
// photo_consent template (photo consent isn't in use → no banner). Otherwise
// returns the resolved granted/denied/not_answered/outdated state so the images
// page can render "consented / not consented / not completed / needs review".
// Studio-scoped; never accepts a client-supplied key.
export async function getPhotoConsentStateForClient(
  studioId: string,
  clientId: string,
): Promise<ConsentRowState | null> {
  const admin = createAdminClient();
  const { data: template } = await admin
    .from("consent_form_templates")
    .select("id, form_type, version")
    .eq("studio_id", studioId)
    .eq("form_type", "photo_consent")
    // is_live, added 2026-08-09 alongside photo consent moving to the portal.
    // This helper shipped in #405 filtering on status alone, which predates
    // the contract that the PORTAL is where photo consent is collected. Under
    // that contract an active-but-hidden template is not an actionable
    // requirement: the client cannot reach it, so Treatment Images must not
    // report "photo consent not completed" against it and send the
    // practitioner chasing an answer nobody can give. Same boundary as
    // getActiveConsentTemplatesForPortal; no separate definition of "live".
    .eq("is_live", true)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!template) return null;

  const { data: sig } = await admin
    .from("client_consent_signatures")
    .select("template_version, response")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("template_id", template.id as string)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return consentRowState(
    { form_type: template.form_type as string, version: template.version as number },
    sig
      ? {
          template_version: sig.template_version as number,
          response: sig.response as string | null,
        }
      : undefined,
  );
}

// The client's CURRENT portal photo-consent status, for the practitioner's
// intake review.
//
// Photo consent left the intake (Chloe, 2026-08-09) and lives only in the
// portal. Without this, "View intake" could show a historical intake photo
// answer and nothing else, so a client who later changed their mind in the
// portal would be represented by a stale answer with no sign that a newer one
// existed. Chloe's actual report was the blunter version of the same gap: her
// route never read `client_consent_signatures` at all, so portal-completed
// consent was invisible there.
//
// Returns null when the studio has no active photo_consent template: photo
// consent is not in use, so the review shows nothing rather than an empty
// "not completed" row that reads like a missing task.
//
// Deliberately reuses consentRowState + the existing practitioner-view
// signature shape, so this surface and the profile card can never disagree
// about what "granted" means. It builds no second signed-consent engine.
export type PortalPhotoConsentView = {
  // The template this status is about. A distinct template id is a distinct
  // consent record, never merged with another.
  templateId: string;
  state: ConsentRowState;
  templateTitle: string;
  currentVersion: number;
  // The latest signature FOR THIS TEMPLATE, when one exists: the full
  // immutable record, so the existing SignedConsentViewer opens it unchanged.
  record: PractitionerSignatureSummary | null;
};

export async function getPortalPhotoConsentsForPractitionerView(
  studioId: string,
  clientId: string,
): Promise<PortalPhotoConsentView[]> {
  const admin = createAdminClient();

  // THE SAME ELIGIBILITY BOUNDARY THE PORTAL USES, and that is the point.
  //
  // `status = 'active'` alone is NOT portal visibility. PR #167 introduced
  // is_live precisely because activating a template for the studio's own
  // workflow used to drop it into the client portal; migration 0072's CHECK
  // (NOT is_live OR status='active') makes is_live imply active, but it
  // deliberately still permits active + is_live=false, a form the owner has
  // activated and deliberately hidden.
  //
  // Claiming "Current portal consent status, Not completed" for such a form
  // would blame the client for not completing something they cannot see. So
  // this reads exactly what getActiveConsentTemplatesForPortal reads, with the
  // same created_at ordering, and never defines portal visibility on its own.
  const { data: templates, error: templatesError } = await admin
    .from("consent_form_templates")
    .select("id, title, version")
    .eq("studio_id", studioId)
    .eq("form_type", "photo_consent")
    .eq("is_live", true)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (templatesError) {
    console.error(
      JSON.stringify({
        event: "portal_photo_consent_templates_failed",
        code: templatesError.code,
        message: templatesError.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  const rows = (templates ?? []) as Array<{
    id: string;
    title: string | null;
    version: number;
  }>;
  // No live photo form: photo consent is not in use in this portal, so the
  // review shows nothing rather than an empty "not completed" row that reads
  // like an outstanding task.
  if (rows.length === 0) return [];

  // ALL of them. A studio may run more than one live photo form: the portal
  // resolver returns every live form of a type, and each is a separate
  // question the client answers separately. Picking the highest `version`
  // across DIFFERENT template ids would be a category error: version is a
  // template's own history, not a ranking between templates, so it would
  // silently hide one consent record behind another.

  // ONE signatures query for every template, mapped in memory rather than a
  // query per template.
  const { data: sigs, error: sigsError } = await admin
    .from("client_consent_signatures")
    .select(
      "id, template_id, template_title_snapshot, template_version, signature_name, signed_at, response, template_body_snapshot, response_label_snapshot, template_hash, created_at",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .in(
      "template_id",
      rows.map((r) => r.id),
    )
    .order("signed_at", { ascending: false });
  if (sigsError) {
    console.error(
      JSON.stringify({
        event: "portal_photo_consent_signatures_failed",
        code: sigsError.code,
        message: sigsError.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }

  // Latest per template_id: first-write-wins over a signed_at-desc list. Keyed
  // STRICTLY by template_id, so one template's signature can never stand in
  // for another's, the outdated/granted/denied calculation below is per
  // template and must stay that way.
  const latestByTemplate = new Map<string, PractitionerSignatureSummary>();
  for (const row of sigs ?? []) {
    const r = row as PractitionerSignatureSummary;
    if (!latestByTemplate.has(r.template_id)) {
      latestByTemplate.set(r.template_id, r);
    }
  }

  return rows.map((t) => {
    const record = latestByTemplate.get(t.id) ?? null;
    return {
      templateId: t.id,
      state: consentRowState(
        { form_type: "photo_consent", version: t.version },
        record
          ? {
              template_version: record.template_version,
              response: record.response,
            }
          : undefined,
      ),
      templateTitle: t.title ?? "Photo consent",
      currentVersion: t.version,
      record,
    };
  });
}
