import { Resend } from "resend";

// Lazily initialized Resend client. If RESEND_API_KEY is missing we keep the
// app running, just warn once, and skip sends. The invitation row still
// persists in the DB and the share-message UI is the user-facing fallback.
const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.warn("RESEND_API_KEY not set. Invitation emails will not send.");
}

export const resend = apiKey ? new Resend(apiKey) : null;

// hone.care is verified in Resend.
export const FROM_ADDRESS = "Hone <hello@hone.care>";
