// PR #155: hard-fail at build time if any "use client" module ever tries
// to import this. Belt-and-braces alongside the existing convention that
// admin-server is invoked only from server actions, route handlers, and
// server-side queries. A client component reaching the import graph would
// expose SUPABASE_SERVICE_ROLE_KEY at runtime by failing-open via env
// inlining; this guard turns the failure into a Next.js build error
// instead. server-only has no runtime cost and only inserts a throwing
// require in client bundles.
import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-role Supabase client. Bypasses RLS. ONLY use inside admin pages
// or server actions that have already verified the caller is an admin.
// The service_role key must never reach the browser.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  }
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
