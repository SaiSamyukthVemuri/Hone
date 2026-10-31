import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings has no content of its own. Resolve identity first (same gate as the
// layout), then land on the one page every role can open.
export default async function SettingsIndexPage() {
  await requirePractitionerWithStudio();
  redirect("/settings/profile");
}
