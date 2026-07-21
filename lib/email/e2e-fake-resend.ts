import "server-only";

// Fake Resend transport for E2E / unit tests ONLY. Same fail-closed posture as
// the fake-Stripe/fake-Google guards: OFF unless the explicit server-only marker
// HONE_E2E_FAKE_RESEND=1 is present, and REFUSED outright in any deployed
// runtime. It sends nothing over the network — it returns a controlled outcome
// so the send-success / provider-rejection / provider-exception paths can be
// exercised without a real Resend key.

function deployedEnvironmentSignal(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

// FAIL-LOUD deployment guard: if the fake flag is set in a deployed runtime,
// throw at construction rather than silently sending fake mail.
export function assertFakeResendNotRequestedInDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.HONE_E2E_FAKE_RESEND !== "1") return;
  const signal = deployedEnvironmentSignal(env);
  if (signal) {
    throw new Error(
      `HONE_E2E_FAKE_RESEND must never be set in a deployed environment (${signal}).`,
    );
  }
}

export function isE2eFakeResendEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.HONE_E2E_FAKE_RESEND === "1" &&
    deployedEnvironmentSignal(env) === null
  );
}

// success  -> provider accepts (error: null)
// reject   -> provider returns an error object (deliverWelcomeEmail -> 'failed')
// throw    -> provider throws (network exception -> 'failed')
// failonce -> throws the FIRST time per recipient, then succeeds (proves retry)
export type FakeResendMode = "success" | "reject" | "throw" | "failonce";

const KNOWN_MODES = new Set<FakeResendMode>([
  "success",
  "reject",
  "throw",
  "failonce",
]);

function asMode(value: string | undefined): FakeResendMode | null {
  return value && KNOWN_MODES.has(value as FakeResendMode)
    ? (value as FakeResendMode)
    : null;
}

export function fakeResendModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FakeResendMode {
  return asMode(env.HONE_E2E_FAKE_RESEND_MODE) ?? "success";
}

// Per-recipient mode control. A single running E2E server exercises every send
// outcome without restarts by seeding studios whose owner_email local-part is
// prefixed with the mode, e.g. `reject+<id>@harness.local`. A global
// HONE_E2E_FAKE_RESEND_MODE env, when set, OVERRIDES the prefix (unit tests rely
// on that); otherwise the recipient prefix decides, defaulting to success.
export function fakeResendModeForRecipient(
  to: string,
  env: NodeJS.ProcessEnv = process.env,
): FakeResendMode {
  const forced = asMode(env.HONE_E2E_FAKE_RESEND_MODE);
  if (forced) return forced;
  const localPart = to.split("@")[0] ?? "";
  const prefix = localPart.split("+")[0]?.toLowerCase();
  return asMode(prefix) ?? "success";
}

// Structural shape both the real Resend client and the fake satisfy (the send
// path only reads `error`).
export type MinimalEmailTransport = {
  emails: {
    send: (args: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    }) => Promise<{ error: { message: string } | null }>;
  };
};

// In-memory record of recipients that have already been failed once, so the
// `failonce` mode can succeed on retry. MODULE-scoped (not per-transport): the
// single E2E Next server process keeps it across requests within a run, and
// getResendTransport() constructs a fresh transport per send. Holds only the
// mode-prefixed harness address (never real recipient content).
const failedOnceRecipients = new Set<string>();

export function createFakeResendTransport(): MinimalEmailTransport {
  return {
    emails: {
      // Records nothing that could leak (no recipient/content persisted beyond
      // the failonce bookkeeping); the outcome is asserted via
      // studio_onboarding.welcome_email_status.
      send: async ({ to }) => {
        const mode = fakeResendModeForRecipient(to);
        if (mode === "throw") {
          throw new Error("fake resend network exception");
        }
        if (mode === "reject") {
          return { error: { message: "fake resend rejected" } };
        }
        if (mode === "failonce") {
          if (!failedOnceRecipients.has(to)) {
            failedOnceRecipients.add(to);
            throw new Error("fake resend network exception (first attempt)");
          }
          return { error: null };
        }
        return { error: null };
      },
    },
  };
}
