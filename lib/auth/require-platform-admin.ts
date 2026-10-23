import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";

// Privileged loaders run independently of layouts, including RSC requests.
// Platform authority is the current authenticated allowlist, not studio role.
export async function requirePlatformAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !isAdmin(user.email)) notFound();
  return user;
}
