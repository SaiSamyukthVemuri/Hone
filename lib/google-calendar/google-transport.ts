import "server-only";
import { isE2eFakeGoogleEnabled } from "./e2e/fake-google-guard";
import { fakeGoogleFetch } from "./e2e/fake-google-provider";

// The single Google network seam used by lib/google-calendar/oauth.ts.
//
// In PRODUCTION this is behaviourally IDENTICAL to `fetch`: the fake-Google
// activation guard is fail-closed and rejects every deployed environment, so
// isE2eFakeGoogleEnabled() is always false and this returns the real network call.
// No browser input, request header/cookie/query/form, or NEXT_PUBLIC_* variable can
// select the fake — the only inputs are the server-only HONE_E2E_* env markers,
// which cannot exist in a deployed runtime. Only the guarded local E2E lane routes
// to the synthetic provider, so NO real Google request is made there.
export function googleFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (isE2eFakeGoogleEnabled()) return fakeGoogleFetch(input, init);
  return fetch(input, init);
}
