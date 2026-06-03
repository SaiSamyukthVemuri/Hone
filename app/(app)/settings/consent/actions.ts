"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { ConsentTemplateFormType } from "@/lib/types/database";

// PR #134. Practitioner-side CRUD for consent_form_templates. Every
// action is gated by getCurrentPractitionerWithStudio() so the
// studio scope is server-resolved; the client cannot supply a
// studio_id. Owner restriction is enforced by the settings layout's
// owner-only tab visibility plus the same isOwner check is mirrored
// here so a non-owner posting directly is also rejected.

const TITLE_MAX = 160;
const BODY_MAX = 20000;

const FORM_TYPES: ConsentTemplateFormType[] = [
  "general",
  "treatment_consent",
  "policy_acknowledgement",
  "card_authorization",
  "photo_consent",
];

function fdStr(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export type ConsentTemplateResult =
  | { ok: true; templateId: string }
  | { ok: false; error: string };

export async function createConsentTemplateAction(
  formData: FormData,
): Promise<ConsentTemplateResult> {
  const title = fdStr(formData, "title");
  const description = fdStr(formData, "description");
  const body = fdStr(formData, "body");
  const formTypeRaw = fdStr(formData, "form_type");
  const status = fdStr(formData, "status") || "active";

  if (title.length < 1) return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `Title must be ${TITLE_MAX} characters or fewer.` };
  }
  if (body.length < 1) return { ok: false, error: "Body is required." };
  if (body.length > BODY_MAX) {
    return { ok: false, error: `Body must be ${BODY_MAX} characters or fewer.` };
  }
  const formType: ConsentTemplateFormType =
    (FORM_TYPES as string[]).includes(formTypeRaw)
      ? (formTypeRaw as ConsentTemplateFormType)
      : "general";
  if (!["draft", "active", "archived"].includes(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) {
    return { ok: false, error: "Only studio owners can manage consent forms." };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("consent_form_templates")
    .insert({
      studio_id: studio.id,
      title,
      description: description.length > 0 ? description : null,
      body,
      form_type: formType,
      status,
      created_by_practitioner_id: practitioner.id,
    })
    .select("id")
    .single();
  if (error || !created) {
    console.error(
      JSON.stringify({
        event: "consent_template_create_failed",
        code: error?.code,
        message: error?.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't save the template. Please try again." };
  }

  revalidatePath("/settings/consent");
  return { ok: true, templateId: created.id };
}

// Updates content (title / description / body / form_type). Bumps
// version because the snapshot model treats version as the "what
// did the client agree to" axis: anyone who signs after this edit
// gets a new snapshot + hash. Existing signatures keep their
// historical version.
export async function updateConsentTemplateAction(
  formData: FormData,
): Promise<ConsentTemplateResult> {
  const id = fdStr(formData, "id");
  const title = fdStr(formData, "title");
  const description = fdStr(formData, "description");
  const body = fdStr(formData, "body");
  const formTypeRaw = fdStr(formData, "form_type");

  if (!id) return { ok: false, error: "Missing template id." };
  if (title.length < 1) return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `Title must be ${TITLE_MAX} characters or fewer.` };
  }
  if (body.length < 1) return { ok: false, error: "Body is required." };
  if (body.length > BODY_MAX) {
    return { ok: false, error: `Body must be ${BODY_MAX} characters or fewer.` };
  }
  const formType: ConsentTemplateFormType =
    (FORM_TYPES as string[]).includes(formTypeRaw)
      ? (formTypeRaw as ConsentTemplateFormType)
      : "general";

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) {
    return { ok: false, error: "Only studio owners can manage consent forms." };
  }

  const admin = createAdminClient();

  // Read current version so the new value is monotonic. Server-side
  // increment because trusting a client-supplied version would let
  // a stale UI bump backwards.
  const { data: existing } = await admin
    .from("consent_form_templates")
    .select("version")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (!existing) {
    return { ok: false, error: "Template not found." };
  }

  const { error } = await admin
    .from("consent_form_templates")
    .update({
      title,
      description: description.length > 0 ? description : null,
      body,
      form_type: formType,
      version: existing.version + 1,
    })
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_template_update_failed",
        code: error.code,
        message: error.message,
        templateId: id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't update the template." };
  }

  revalidatePath("/settings/consent");
  return { ok: true, templateId: id };
}

export type ConsentTemplateStatusResult =
  | { ok: true }
  | { ok: false; error: string };

export async function setConsentTemplateStatusAction(
  formData: FormData,
): Promise<ConsentTemplateStatusResult> {
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status");
  if (!id) return { ok: false, error: "Missing template id." };
  if (!["draft", "active", "archived"].includes(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) {
    return { ok: false, error: "Only studio owners can manage consent forms." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("consent_form_templates")
    .update({ status })
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "consent_template_status_failed",
        code: error.code,
        message: error.message,
        templateId: id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't update status." };
  }

  revalidatePath("/settings/consent");
  return { ok: true };
}
