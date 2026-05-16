import { Resend } from "resend";

// Lazily initialized Resend client. If RESEND_API_KEY is missing we keep the
// app running, just warn once, and skip sends. The invitation row still
// persists in the DB and the share-message UI is the user-facing fallback.
const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.warn("RESEND_API_KEY not set. Invitation emails will not send.");
}

export const resend = apiKey ? new Resend(apiKey) : null;

// Until a verified hone.care sender exists in Resend, use Resend's onboarding
// sandbox sender. Replace with "Hone <hello@hone.care>" once DNS is wired up.
export const FROM_ADDRESS = "Hone <onboarding@resend.dev>";
