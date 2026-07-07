import type { TrackingProvider } from "@/lib/conversion/types";

// Provider onboarding registry (pure, client-safe copy — no server-only, no I/O,
// no secrets). Drives the Settings → Marketing & analytics provider selector.
// Meta is the only "available" (editable) provider; the rest are "coming_soon"
// with onboarding overviews but NO editable token fields and NO save action.
//
// Help links are OFFICIAL provider documentation only. No third-party videos:
// videoUrl stays null until an official walkthrough is confirmed, and the UI
// shows a "coming soon" fallback.

export type ProviderStatus = "available" | "coming_soon";

export type ProviderHelpLink = { label: string; href: string };
export type ProviderSetupSection = { title: string; steps: string[] };

export type ProviderRegistryEntry = {
  provider: TrackingProvider;
  displayName: string;
  status: ProviderStatus;
  // Whether editable setup fields (token form) are shown. Only Meta today.
  editable: boolean;
  description: string;
  purpose: string;
  requiredFields: string[];
  setupSections: ProviderSetupSection[];
  helpLinks: ProviderHelpLink[];
  // Official walkthrough only; null → UI shows "Video walkthrough: coming soon".
  videoUrl: string | null;
  privacyNote: string;
};

const DATA_SAFETY_NOTE =
  "Hone sends only a minimal booking conversion event. Hone does not send treatment notes, intake answers, body areas, photos, contraindications, appointment notes, or payment/card data.";

const COMING_SOON_ARCHITECTURE_NOTE =
  "This provider is supported by Hone's tracking architecture, but the sender is not enabled yet.";

const META: ProviderRegistryEntry = {
  provider: "meta",
  displayName: "Meta — Facebook & Instagram (Conversions API)",
  status: "available",
  editable: true,
  description:
    "Send confirmed bookings to Meta as a Schedule conversion via the Conversions API.",
  purpose:
    "Measure which Facebook/Instagram ads and website visits lead to booked consultations.",
  requiredFields: [
    "Pixel / Dataset ID",
    "Conversions API token",
    "Test Event Code (optional, testing only)",
    "Enabled checkbox",
  ],
  setupSections: [
    {
      title: "Before you start",
      steps: [
        "Use the studio's OWN Meta Business account — do not use Hone's Meta account.",
        "You need admin access to the studio's Meta Business portfolio / Events Manager.",
        "Hone stores the token encrypted and only ever shows the last 4 characters later.",
      ],
    },
    {
      title: "Pixel / Dataset ID",
      steps: [
        "Open Meta Business Suite or Events Manager.",
        "Go to Data Sources.",
        "Select or create the studio's Pixel / Dataset.",
        "Copy the Dataset ID / Pixel ID.",
        "Paste it into Hone's Pixel / Dataset ID field.",
      ],
    },
    {
      title: "Conversions API token",
      steps: [
        "In Meta Events Manager, open the same Dataset.",
        "Go to Settings.",
        "Find Conversions API.",
        "Choose Generate access token.",
        "Copy the token once.",
        "Paste it into Hone's Conversions API token field.",
        "Do not email or share this token.",
        "If lost, generate a new one and rotate it in Hone.",
      ],
    },
    {
      title: "Test Event Code",
      steps: [
        "In Meta Events Manager, open Test Events.",
        "Copy the Test Event Code.",
        "Paste it into Hone while testing.",
        "After a successful test booking, clear the Test Event Code before real traffic.",
      ],
    },
    {
      title: "Enable checkbox",
      steps: [
        "Keep disabled until you are ready to test.",
        "Enable only after privacy/cookie consent is set up.",
        "Hone sends booking events only when the client accepted optional marketing/analytics tracking.",
      ],
    },
  ],
  helpLinks: [
    { label: "Meta Business Help Center", href: "https://www.facebook.com/business/help" },
    {
      label: "Conversions API — developer docs",
      href: "https://developers.facebook.com/docs/marketing-api/conversions-api",
    },
    {
      label: "Get started with the Conversions API",
      href: "https://developers.facebook.com/docs/marketing-api/conversions-api/get-started",
    },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const GOOGLE_ADS: ProviderRegistryEntry = {
  provider: "google_ads",
  displayName: "Google Ads",
  status: "coming_soon",
  editable: false,
  description: "Track confirmed bookings as Google Ads conversions.",
  purpose: "Attribute booked consultations to Google Ads campaigns.",
  requiredFields: [
    "Google Ads account",
    "Conversion action ID / label",
    "Enhanced conversions or offline conversion setup",
  ],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "About conversion tracking (Google Ads Help)", href: "https://support.google.com/google-ads/answer/1722022" },
    { label: "Enhanced conversions (Google Ads Help)", href: "https://support.google.com/google-ads/answer/9888656" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const GA4: ProviderRegistryEntry = {
  provider: "ga4",
  displayName: "Google Analytics 4",
  status: "coming_soon",
  editable: false,
  description: "Send booking and lead analytics to Google Analytics 4.",
  purpose: "See booking/lead events alongside your GA4 traffic analytics.",
  requiredFields: ["GA4 Measurement ID", "Measurement Protocol API secret"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "GA4 Measurement Protocol (developer docs)", href: "https://developers.google.com/analytics/devguides/collection/protocol/ga4" },
    { label: "Google Analytics Help", href: "https://support.google.com/analytics" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const TIKTOK: ProviderRegistryEntry = {
  provider: "tiktok",
  displayName: "TikTok",
  status: "coming_soon",
  editable: false,
  description: "Track bookings from TikTok campaigns.",
  purpose: "Attribute booked consultations to TikTok ads.",
  requiredFields: ["TikTok Pixel ID", "Events API token"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "TikTok Marketing API docs", href: "https://business-api.tiktok.com/portal/docs" },
    { label: "TikTok Ads Help Center", href: "https://ads.tiktok.com/help" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const PINTEREST: ProviderRegistryEntry = {
  provider: "pinterest",
  displayName: "Pinterest",
  status: "coming_soon",
  editable: false,
  description: "Track bookings from Pinterest campaigns.",
  purpose: "Attribute booked consultations to Pinterest ads.",
  requiredFields: ["Pinterest Tag / Ad Account ID", "Conversions API token"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "Pinterest Conversions API (developer docs)", href: "https://developers.pinterest.com/docs/conversions/conversions/" },
    { label: "Pinterest Business Help", href: "https://help.pinterest.com/en/business" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const LINKEDIN: ProviderRegistryEntry = {
  provider: "linkedin",
  displayName: "LinkedIn",
  status: "coming_soon",
  editable: false,
  description: "Track bookings from LinkedIn campaigns.",
  purpose: "Attribute booked consultations to LinkedIn ads.",
  requiredFields: ["LinkedIn Insight Tag / Ad Account", "Conversions API access token"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "LinkedIn Insight Tag & conversions (Help)", href: "https://www.linkedin.com/help/lms" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const MICROSOFT_ADS: ProviderRegistryEntry = {
  provider: "microsoft_ads",
  displayName: "Microsoft Ads",
  status: "coming_soon",
  editable: false,
  description: "Track bookings as Microsoft Advertising conversions.",
  purpose: "Attribute booked consultations to Microsoft (Bing) ads.",
  requiredFields: ["UET tag ID", "Conversion goal / offline conversion setup"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [
    { label: "Microsoft Advertising Help (UET & conversions)", href: "https://help.ads.microsoft.com" },
  ],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

const CUSTOM: ProviderRegistryEntry = {
  provider: "custom",
  displayName: "Custom integration",
  status: "coming_soon",
  editable: false,
  description: "A studio-specific or bespoke conversion endpoint.",
  purpose: "Send confirmed bookings to a custom provider your team operates.",
  requiredFields: ["Endpoint / dataset id", "API token"],
  setupSections: [{ title: "Coming soon", steps: [COMING_SOON_ARCHITECTURE_NOTE] }],
  helpLinks: [],
  videoUrl: null,
  privacyNote: DATA_SAFETY_NOTE,
};

// Selector order: available first, then coming soon.
export const PROVIDER_REGISTRY: ReadonlyArray<ProviderRegistryEntry> = [
  META,
  GOOGLE_ADS,
  GA4,
  TIKTOK,
  PINTEREST,
  LINKEDIN,
  MICROSOFT_ADS,
  CUSTOM,
];

export function getProviderEntry(
  provider: string,
): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((p) => p.provider === provider);
}

export const VIDEO_COMING_SOON_FALLBACK =
  "Video walkthrough: coming soon. Ask your ads manager to help create the provider account, dataset/pixel, and API token.";
