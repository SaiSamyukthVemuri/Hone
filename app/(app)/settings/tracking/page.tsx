import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { TrackingProvider } from "@/lib/conversion/types";
import { TrackingProviderForm } from "./TrackingProviderForm";
import {
  clearTrackingTokenAction,
  saveTrackingProviderConfigAction,
} from "./actions";

// Provider-agnostic: Meta is the first available adapter; the others are
// planned. These "coming soon" entries are DISPLAY ONLY — no token fields, no
// actions, no rows created, nothing sent. (Typed to the provider enum so the
// list can't drift from the backend's supported set.)
const COMING_SOON_PROVIDERS: ReadonlyArray<{
  provider: Exclude<TrackingProvider, "meta" | "custom">;
  label: string;
  detail: string;
}> = [
  { provider: "google_ads", label: "Google Ads", detail: "Enhanced / Offline Conversions" },
  { provider: "ga4", label: "Google Analytics 4", detail: "Measurement Protocol" },
  { provider: "tiktok", label: "TikTok", detail: "Events API" },
  { provider: "pinterest", label: "Pinterest", detail: "Conversions API" },
  { provider: "linkedin", label: "LinkedIn", detail: "Conversions API" },
  { provider: "microsoft_ads", label: "Microsoft Ads", detail: "Offline conversions (UET)" },
];

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
          Optional. Connect your studio-owned marketing and analytics providers
          to measure bookings from your website and ads. Your provider accounts,
          pixels, and tokens are yours — Hone stores each token encrypted and
          only ever sends a minimal, non-clinical booking event, and only when a
          client has agreed to marketing tracking. Off unless you enable it.
        </p>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <strong>Meta is available now.</strong> Additional providers can be
          added later — this is a provider-agnostic integration, not a
          Meta-only feature.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Available now
        </h3>
        <TrackingProviderForm
          provider="meta"
          providerLabel="Meta — Facebook &amp; Instagram (Conversions API)"
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
      </div>

      {/* Coming soon: DISPLAY ONLY. No inputs, no token fields, no actions —
          these do not create config rows or send anything. */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Coming soon
        </h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {COMING_SOON_PROVIDERS.map((p) => (
            <li
              key={p.provider}
              aria-disabled="true"
              className="flex items-center justify-between rounded-lg border border-dashed border-neutral-200 px-4 py-3 opacity-70 dark:border-neutral-800"
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {p.label}
                </span>
                <span className="text-xs text-neutral-500">{p.detail}</span>
              </span>
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                Coming soon
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-neutral-500">
          These providers aren&rsquo;t connected yet — no token can be added and
          nothing is sent to them.
        </p>
      </div>
    </section>
  );
}
