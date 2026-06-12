import { E2E_MAILPIT_URL } from "./local-env";

// Mailpit helper (PR #227): the local Supabase stack routes ALL
// GoTrue auth email to Mailpit (http://127.0.0.1:54324), so the E2E
// login drives the REAL magic-link path end to end with zero auth
// bypass. App emails (Resend) never reach Mailpit: they fail
// gracefully against the dummy key, exactly like the fast CI lane.

type MailpitMessage = { ID: string; To: Array<{ Address: string }> };

async function searchMessages(email: string): Promise<MailpitMessage[]> {
  const list = await fetch(
    `${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
  ).then((r) => r.json() as Promise<{ messages: MailpitMessage[] }>);
  return list.messages ?? [];
}

// Snapshot the ids already in the inbox so a SECOND login for the
// same address never re-reads the first (single-use, now-consumed)
// magic link.
export async function listMessageIds(email: string): Promise<string[]> {
  return (await searchMessages(email)).map((m) => m.ID);
}

export async function waitForMagicLink(
  email: string,
  appOrigin: string,
  options: { excludeIds?: string[]; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exclude = new Set(options.excludeIds ?? []);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = (await searchMessages(email)).find(
      (m) => !exclude.has(m.ID),
    );
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
