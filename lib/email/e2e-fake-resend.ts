import "server-only";

// Fake Resend transport for E2E / unit tests ONLY. Same fail-closed posture as
// the fake-Stripe/fake-Google guards: OFF unless the explicit server-only marker
// HONE_E2E_FAKE_RESEND=1 is present, and REFUSED outright in any deployed
// runtime. It sends nothing over the network. It returns a controlled outcome
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
// reject   -> provider returns a TERMINAL error object: retryable === false,
//             the shape a provider uses for a payload it will never accept
//             (deliverWelcomeEmail -> 'failed')
// throw    -> provider throws (network exception -> 'failed', retryable)
// failonce -> throws the FIRST time per recipient, then succeeds (proves retry)
// hold     -> succeeds, but only after HOLD_MS. The send is genuinely IN FLIGHT
//             for that window, which is the only way to observe what a surface
//             does while a submission is pending. Bounded and self-releasing:
//             no test can leave a request hanging.
export type FakeResendMode = "success" | "reject" | "throw" | "failonce" | "hold";

const KNOWN_MODES = new Set<FakeResendMode>([
  "success",
  "reject",
  "throw",
  "failonce",
  "hold",
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
// prefixed with the mode, e.g. `reject+<id>@harness.local`.
//
// PRECEDENCE, highest first:
//   1. HONE_E2E_FAKE_RESEND_MODE          global force (unit tests rely on it)
//   2. the recipient's local-part prefix  per-send control, no restart needed
//   3. HONE_E2E_FAKE_RESEND_DEFAULT_MODE  the host's default for "asks nothing"
//   4. "success"                          library default
/** How long `hold` keeps a send in flight. Long enough to observe a pending
 *  surface, short enough that a suite never waits on it meaningfully. */
export const HOLD_MS = 4_000;

export function fakeResendModeForRecipient(
  to: string,
  env: NodeJS.ProcessEnv = process.env,
): FakeResendMode {
  const forced = asMode(env.HONE_E2E_FAKE_RESEND_MODE);
  if (forced) return forced;
  const localPart = to.split("@")[0] ?? "";
  const prefix = localPart.split("+")[0]?.toLowerCase();
  const byPrefix = asMode(prefix);
  if (byPrefix) return byPrefix;
  // RESCHEDULE-E2E-01: the HOST'S default, for recipients that ask for nothing.
  //
  // Arming the fake for a whole lane changes what every spec that asks for
  // nothing gets. With `success` as the only fallback, each documented
  // degraded-path scenario in the suite silently became an ACCEPTED send --
  // and kept passing, because those specs assert what is absent on a refusal,
  // which is also absent on success. The browser lane therefore sets this to
  // `reject`, reproducing exactly what the dummy Resend key used to produce
  // for every send, and a spec that needs ACCEPTANCE opts in with a `success+`
  // recipient. Behaviour-preserving by default, explicit where it differs.
  //
  // The library default stays `success`, so unit tests and any non-lane
  // consumer are unaffected.
  return asMode(env.HONE_E2E_FAKE_RESEND_DEFAULT_MODE) ?? "success";
}

// Structural shape both the real Resend client and the fake satisfy.
//
// RESCHEDULE-E2E-01 widened this to the FULL payload the appointment send path
// builds (`lib/email/send-appointment.ts`), and to the full result it reads.
// Before, the type covered only the onboarding fields, which is why
// `sendEmailSafely` could not be typed against it and reached for the raw
// `resend` client instead -- taking the appointment and public-reschedule
// confirmations outside the fake entirely. The optional members keep every
// existing caller compatible: the narrower onboarding payload still satisfies
// it, and the real Resend client still satisfies it structurally.
export type MinimalEmailTransport = {
  emails: {
    send: (args: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
      replyTo?: string;
      attachments?: ReadonlyArray<{ filename: string; content: Buffer }>;
    }) => Promise<{
      data?: { id?: string } | null;
      // The error envelope carries what `classifyResendError` in
      // lib/email/send-appointment.ts actually READS -- `statusCode` and
      // `name`, not just a message. An envelope narrowed to `message` cannot
      // express a TERMINAL provider refusal at all: the classifier falls
      // through to `retryable: true` for an unfamiliar shape, so a fake
      // "rejection" would be indistinguishable from a transient blip and the
      // terminal-refusal bookkeeping would never be exercised.
      error: { message: string; name?: string; statusCode?: number } | null;
    }>;
  };
};

// In-memory record of recipients that have already been failed once, so the
// `failonce` mode can succeed on retry. MODULE-scoped (not per-transport): the
// single E2E Next server process keeps it across requests within a run, and
// getResendTransport() constructs a fresh transport per send. Holds only the
// mode-prefixed harness address (never real recipient content).
const failedOnceRecipients = new Set<string>();

/** Stand-in provider message id. A caller that records a message id records
 *  this, so a fake success is never mistaken for a real provider receipt. */
export const FAKE_MESSAGE_ID = "fake-resend-message-id";

export function createFakeResendTransport(): MinimalEmailTransport {
  return {
    emails: {
      // Records nothing that could leak (no recipient/content persisted beyond
      // the failonce bookkeeping); the outcome is asserted via
      // studio_onboarding.welcome_email_status.
      send: async ({ to }) => {
        const mode = fakeResendModeForRecipient(to);
        if (mode === "hold") {
          // GENUINELY IN FLIGHT for HOLD_MS. Bounded and self-releasing: no test
          // can leave a request hanging, and nothing outside the fake changes.
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          return { data: { id: FAKE_MESSAGE_ID }, error: null };
        }
        if (mode === "throw") {
          throw new Error("fake resend network exception");
        }
        if (mode === "reject") {
          // A TERMINAL refusal, the kind a provider returns for a payload it
          // will never accept. Both fields are independently terminal under
          // `classifyResendError` (422 is a 4xx, and `validation_error` is one
          // of its named terminal cases), so the classification does not depend
          // on which branch it checks first.
          return {
            error: {
              message: "fake resend rejected",
              name: "validation_error",
              statusCode: 422,
            },
          };
        }
        if (mode === "failonce") {
          if (!failedOnceRecipients.has(to)) {
            failedOnceRecipients.add(to);
            throw new Error("fake resend network exception (first attempt)");
          }
          return { data: { id: FAKE_MESSAGE_ID }, error: null };
        }
        return { data: { id: FAKE_MESSAGE_ID }, error: null };
      },
    },
  };
}
