import { E2E_MAILPIT_URL } from "./local-env";

// Mailpit helper (PR #227): the local Supabase stack routes ALL
// GoTrue auth email to Mailpit (http://127.0.0.1:54324), so the E2E
// login drives the REAL magic-link path end to end with zero auth
// bypass. App emails (Resend) never reach Mailpit: they fail
// gracefully against the dummy key, exactly like the fast CI lane.

type MailpitMessage = { ID: string; To: Array<{ Address: string }> };

export async function waitForMagicLink(
  email: string,
  appOrigin: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await fetch(
      `${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((r) => r.json() as Promise<{ messages: MailpitMessage[] }>);
    const message = list.messages?.[0];
    if (message) {
      const full = await fetch(
        `${E2E_MAILPIT_URL}/api/v1/message/${message.ID}`,
      ).then((r) => r.json() as Promise<{ Text: string; HTML: string }>);
      const body = `${full.Text ?? ""}\n${full.HTML ?? ""}`;
      const match = body.match(/https?:\/\/[^\s"'<>\])]+verify[^\s"'<>\])]*/);
      if (match) {
        // GoTrue verify link; following it redirects to the app's
        // /auth/callback. Decode entities the HTML body may carry.
        return match[0].replaceAll("&amp;", "&");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `no magic link for ${email} arrived in Mailpit within ${timeoutMs}ms (is the local stack running with supabase start?). App origin: ${appOrigin}`,
  );
}
