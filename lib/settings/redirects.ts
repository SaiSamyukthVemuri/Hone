// Old Settings deep links to their focused routes (R2).
//
// Before R2 a longer page held several sections and the rail jumped to them with
// a URL fragment. Each section is now its own route, so an old bookmark or a
// search result such as /settings/studio#email-notifications must land on the
// new view. A server cannot see a fragment, so the shell reads it on the client
// and forwards before first paint (components/settings/hash-redirect.tsx). The
// old PATHS that moved (/settings/intake, /settings/tracking, group doorways)
// are redirected by their own server pages.

export const SETTINGS_HASH_REDIRECTS: Readonly<Record<string, string>> = {
  // Calendar > Display preferences (these lived on Studio, then on Calendar)
  "birthday-color": "/settings/calendar/display",
  "time-format": "/settings/calendar/display",
  "display-preferences": "/settings/calendar/display",
  // Studio
  "studio-details": "/settings/studio/details",
  "studio-name": "/settings/studio/details",
  "legal-entity": "/settings/studio/details",
  "email-notifications": "/settings/studio/email",
  "sms-notifications": "/settings/studio/text-messages",
  "client-self-service": "/settings/studio/client-self-service",
  // Forms & postcare
  postcare: "/settings/forms/postcare",
  aftercare: "/settings/forms/postcare",
  "postcare-contact": "/settings/forms/postcare",
  policies: "/settings/forms/cancellation-policy",
  "intake-preview": "/settings/forms/intake-preview",
  // Booking
  "booking-link": "/settings/booking/link",
  "booking-slug": "/settings/booking/link",
  "new-client-admission": "/settings/booking/link",
  "booking-horizon": "/settings/booking/window",
  timezone: "/settings/booking/window",
  "default-duration": "/settings/booking/window",
  buffer: "/settings/booking/window",
  "public-address": "/settings/booking/window",
  "booking-intro": "/settings/booking/window",
};
