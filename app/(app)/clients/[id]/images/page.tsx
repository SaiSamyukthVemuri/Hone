import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS } from "@/lib/images/treatment-images";
import { TreatmentImagesManager } from "./TreatmentImagesManager";

// PR #271. Practitioner-only treatment images. Gated by the app shell's
// requirePractitionerWithStudio layout; data is loaded with the RLS client
// scoped to the resolved studio. Image bytes are NEVER served here — only
// metadata; viewing mints a short-TTL signed URL via a server action.
export const dynamic = "force-dynamic";

export default async function ClientImagesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name")
    .eq("studio_id", studio.id)
    .eq("id", id)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message);
  if (!client) notFound();

  const { data: images, error: imgErr } = await supabase
    .from("treatment_images")
    .select("id, original_filename, created_at, storage_bucket, storage_path")
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (imgErr) throw new Error(imgErr.message);

  // PR #273: server-side preview signing. Ownership is already verified (the
  // RLS client load above is scoped to this studio + client). Short-TTL signed
  // URLs are returned ONLY in this response — never stored in the DB, never
  // public. storage_path stays server-side; only the signed URL reaches the
  // client. A failed sign yields previewUrl=null → the card shows
  // "Image not available" but keeps filename/date/Archive.
  const meta = (images ?? []) as Array<{
    id: string;
    original_filename: string | null;
    created_at: string;
    storage_bucket: string;
    storage_path: string;
  }>;
  const admin = createAdminClient();
  const rows = await Promise.all(
    meta.map(async (m) => {
      let previewUrl: string | null = null;
      try {
        const { data } = await admin.storage
          .from(m.storage_bucket)
          .createSignedUrl(
            m.storage_path,
            TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
          );
        previewUrl = data?.signedUrl ?? null;
      } catch {
        previewUrl = null;
      }
      return {
        id: m.id,
        filename: m.original_filename ?? null,
        createdAt: m.created_at,
        previewUrl,
      };
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/clients/${id}`}
        className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        ← {client.name}
      </Link>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Treatment Photos</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Stored privately. Visible to practitioners in this studio.
        </p>
      </header>
      <TreatmentImagesManager clientId={id} images={rows} />
    </div>
  );
}
