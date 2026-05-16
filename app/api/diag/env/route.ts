import { NextResponse } from "next/server";

// Public diagnostic. Returns presence-only metadata about env vars so we can
// verify Vercel wired everything up without leaking secret values.
// IMPORTANT: never log full secret values here. Length + first 4 chars is the cap.
export async function GET() {
  return NextResponse.json({
    SUPABASE_SERVICE_ROLE_KEY_exists: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY_length:
      process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0,
    SUPABASE_SERVICE_ROLE_KEY_starts_with:
      process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 4) || "NONE",
    NEXT_PUBLIC_SUPABASE_URL_exists: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY_exists:
      !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    node_env: process.env.NODE_ENV,
  });
}
