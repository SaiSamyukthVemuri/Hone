import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { TrackingProviderForm } from "./TrackingProviderForm";
import {
  clearTrackingTokenAction,
  saveTrackingProviderConfigAction,
} from "./actions";

// Owner-only marketing/analytics provider settings. Self-serve: the owner adds
// their own Pixel/Dataset id + CAPI token; the token is encrypted at rest and
// only its last4 + status are ever shown. The raw/encrypted token is NEVER
// selected here or sent to the client. Tracking is disabled by default.

type ProviderRow = {
  provider: string;
  enabled: boolean;
  browser_tag_id: string | null;
  test_event_code: string | null;
  server_token_last4: string | null;
  token_status: string;
};

export default async function TrackingSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="px-5 py-6 text-sm text-neutral-600 dark:text-neutral-400">
        Only studio owners can manage marketing &amp; analytics tracking.
      </section>
    );
  }

  const admin = createAdminClient();
  // Redacted status ONLY — encrypted_server_token is never selected.
  const { data } = await admin
    .from("studio_tracking_providers")
    .select(
      "provider, enabled, browser_tag_id, test_event_code, server_token_last4, token_status",
    )
    .eq("studio_id", studio.id);
  const meta = (data as ProviderRow[] | null)?.find((r) => r.provider === "meta") ?? null;

  return (
    <section className="flex flex-col gap-4 px-5 py-6">
      <header>
        <h2 className="text-lg font-semibold tracking-tight">
          Marketing &amp; analytics tracking
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Optional. Connect your own advertising/analytics provider to measure
          bookings from your website and ads. Your provider account, pixel, and
          token are yours — Hone stores your token encrypted and only ever sends
          a minimal, non-clinical booking event, and only when a client has
          agreed to marketing tracking. Off unless you enable it.
        </p>
      </header>

      <TrackingProviderForm
        provider="meta"
        providerLabel="Meta (Conversions API)"
        current={
          meta
            ? {
                enabled: meta.enabled,
                browserTagId: meta.browser_tag_id,
                testEventCode: meta.test_event_code,
                tokenLast4: meta.server_token_last4,
                tokenStatus: meta.token_status,
              }
            : null
        }
        saveAction={saveTrackingProviderConfigAction}
        clearTokenAction={clearTrackingTokenAction}
      />
    </section>
  );
}
