import "server-only";

// HELD (Sam, 2026-10-28): the client identification portrait (0231) shipped
// with no policy gate, and consent and retention approval are still
// outstanding. Portrait use is OFF until an explicit enabling input exists.
//
// The ONLY enabling input is HONE_CLIENT_PORTRAIT_ENABLED === "true". It is
// absent in every environment, so the result is OFF. Anything else (unset,
// empty, "TRUE", "1", "yes", whitespace) fails closed.
//
// This gates the app. It is not a database control: a studio member can still
// call set_client_portrait directly through the Data API until a DB-side gate
// lands as a migration.
export function clientPortraitEnabled(): boolean {
  return process.env.HONE_CLIENT_PORTRAIT_ENABLED === "true";
}
