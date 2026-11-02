import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/integrations is only a doorway to its first view; each integration
// is its own route. A non-owner is sent to Profile by the view itself.
//
// An OAuth flow started before the split still returns here with its outcome
// (?gcal=...), so the query string rides along to the Google Calendar view,
// where the card reads it and explains why authorization failed.
export default async function IntegrationsSettingsIndex({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePractitionerWithStudio();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries((await searchParams) ?? {})) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, v);
    }
  }
  const query = params.toString();
  redirect(
    `/settings/integrations/google-calendar${query ? `?${query}` : ""}`,
  );
}
