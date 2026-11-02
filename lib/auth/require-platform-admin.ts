import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isProvenPlatformAdmin } from "@/lib/auth/session-email-proof";

// Privileged loaders run independently of layouts, including RSC requests.
// Platform authority is the current authenticated allowlist, not studio role.
export async function requirePlatformAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !(await isProvenPlatformAdmin(supabase, user))) notFound();
  return user;
}
