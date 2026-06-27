import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
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
    .select("id, original_filename, created_at")
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (imgErr) throw new Error(imgErr.message);

  const rows = (images ?? []).map((r) => ({
    id: r.id as string,
    filename: (r.original_filename as string | null) ?? null,
    createdAt: r.created_at as string,
  }));

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
