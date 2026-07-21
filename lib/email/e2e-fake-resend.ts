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

export type FakeResendMode = "success" | "reject" | "throw";

export function fakeResendModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FakeResendMode {
  const m = env.HONE_E2E_FAKE_RESEND_MODE;
  return m === "reject" || m === "throw" ? m : "success";
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

export function createFakeResendTransport(
  mode: FakeResendMode,
): MinimalEmailTransport {
  return {
    emails: {
      // Records nothing that could leak (no recipient/content persisted here);
      // the outcome is asserted via studio_onboarding.welcome_email_status.
      send: async () => {
        if (mode === "throw") {
          throw new Error("fake resend network exception");
        }
        if (mode === "reject") {
          return { error: { message: "fake resend rejected" } };
        }
        return { error: null };
      },
    },
  };
}
