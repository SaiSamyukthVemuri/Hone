import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  ClientConsentSignature,
  ClientConsentSignatureResponse,
  ConsentFormTemplate,
} from "@/lib/types/database";

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
>;

export async function getLatestSignaturesForPractitionerView(
  studioId: string,
  clientId: string,
): Promise<PractitionerSignatureSummary[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_consent_signatures")
    .select(
      "id, template_id, template_title_snapshot, template_version, signature_name, signed_at, response",
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
