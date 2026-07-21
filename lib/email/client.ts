import { Resend } from "resend";
import {
  assertFakeResendNotRequestedInDeployment,
  createFakeResendTransport,
  fakeResendModeFromEnv,
  isE2eFakeResendEnabled,
  type MinimalEmailTransport,
} from "./e2e-fake-resend";

// Fail-loud if the E2E fake flag is ever set in a deployed runtime.
assertFakeResendNotRequestedInDeployment();

// Lazily initialized Resend client. If RESEND_API_KEY is missing we keep the
// app running, just warn once, and skip sends. The invitation row still
// persists in the DB and the share-message UI is the user-facing fallback.
const apiKey = process.env.RESEND_API_KEY;
if (!apiKey && !isE2eFakeResendEnabled()) {
  console.warn("RESEND_API_KEY not set. Invitation emails will not send.");
}

export const resend = apiKey ? new Resend(apiKey) : null;

// hone.care is verified in Resend.
export const FROM_ADDRESS = "Hone <hello@hone.care>";

// The email transport for onboarding welcome/invitation mail: the fake E2E
// transport when explicitly enabled (server-only, refused in a deployed
// runtime), else the real Resend client (or null). The real Resend client is
// structurally compatible with the minimal transport shape the send path uses.
export function getResendTransport(): MinimalEmailTransport | null {
  if (isE2eFakeResendEnabled()) {
    return createFakeResendTransport(fakeResendModeFromEnv());
  }
  return resend as unknown as MinimalEmailTransport | null;
}
