"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { requestPractitionerMagicLinkAction } from "./actions";

const PALETTE = {
  bg: "#FAFAF7",
  ink: "#0A0A0A",
  muted: "#6B6B6B",
  rule: "#E5E2DA",
  hoverBg: "#F5F2EB",
} as const;

type Status =
  | { kind: "idle" }
  | { kind: "google" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [agreed, setAgreed] = useState(false);

  async function handleGoogle() {
    if (!agreed) {
      setStatus({
        kind: "error",
        message: "Please agree to the Terms of Service and Privacy Policy.",
      });
      return;
    }
    setStatus({ kind: "google" });
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setStatus({ kind: "error", message: error.message });
    }
    // On success the browser is redirected by Supabase; no further state to set.
  }

  async function handleMagicLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreed) {
      setStatus({
        kind: "error",
        message: "Please agree to the Terms of Service and Privacy Policy.",
      });
      return;
    }
    setStatus({ kind: "sending" });

    // PR #189 (pilot safety): the magic-link request goes through a
    // server action that gates auth-user creation on a pending
    // invitation (shouldCreateUser=false for everyone else). Hone is
    // invite-only during the pilot; uninvited unknown emails see the
    // same generic "sent" state and no account or studio is created.
    const result = await requestPractitionerMagicLinkAction(email);
    if (!result.ok) {
      setStatus({ kind: "error", message: result.error });
    } else {
      setStatus({ kind: "sent" });
    }
  }

  const isBusy = status.kind === "google" || status.kind === "sending";
  const gateDisabled = isBusy || !agreed;

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="flex min-h-screen items-center justify-center px-6 font-[var(--font-inter)]"
    >
      <div className="mx-auto w-full max-w-[420px] py-12">
        <div className="mb-12 text-center">
          <Link
            href="/"
            className="font-[var(--font-fraunces)] inline-block text-[28px] font-bold leading-none"
            style={{ letterSpacing: "-0.02em", color: PALETTE.ink }}
          >
            Hone
          </Link>
        </div>

        <h1
          className="font-[var(--font-fraunces)] mb-4 text-center text-[36px] font-bold leading-[1]"
          style={{ letterSpacing: "-0.02em", color: PALETTE.ink }}
        >
          Sign in to Hone
        </h1>

        {/* PR #253: Hone is invite-only for supervised studios. This is a
            sign-IN page, not self-serve signup; uninvited emails create no
            account or studio. */}
        <p
          className="mb-10 text-center text-[14px] leading-[1.55]"
          style={{ color: PALETTE.muted }}
        >
          Invited users only. Use the email address your studio invitation was
          sent to.
        </p>

        {status.kind === "sent" ? (
          <SentNotice email={email} />
        ) : (
          <>
            <label className="mb-6 flex items-start gap-3 text-left text-[13px] leading-[1.55]">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => {
                  setAgreed(e.target.checked);
                  if (e.target.checked && status.kind === "error") {
                    setStatus({ kind: "idle" });
                  }
                }}
                disabled={isBusy}
                aria-label="Agree to Terms of Service and Privacy Policy"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span style={{ color: PALETTE.ink }}>
                I agree to the{" "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Privacy Policy
                </a>
                .
              </span>
            </label>

            <button
              type="button"
              onClick={handleGoogle}
              disabled={gateDisabled}
              className="mx-auto mb-6 flex w-full items-center justify-center gap-3 px-6 py-3 text-[14px] font-medium transition-colors disabled:opacity-50"
              style={{
                border: `1px solid ${PALETTE.ink}`,
                backgroundColor: "#FFFFFF",
                color: PALETTE.ink,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = PALETTE.hoverBg;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#FFFFFF";
              }}
            >
              <GoogleGIcon />
              <span>
                {status.kind === "google"
                  ? "Connecting"
                  : "Continue with Google"}
              </span>
            </button>

            <div className="mb-6 flex items-center gap-4">
              <span
                aria-hidden="true"
                className="h-px flex-1"
                style={{ backgroundColor: PALETTE.rule }}
              />
              <span
                className="text-[11px] lowercase"
                style={{ color: PALETTE.muted, letterSpacing: "0.04em" }}
              >
                or
              </span>
              <span
                aria-hidden="true"
                className="h-px flex-1"
                style={{ backgroundColor: PALETTE.rule }}
              />
            </div>

            <form onSubmit={handleMagicLink}>
              <label
                htmlFor="login-email"
                className="mb-2 block text-left text-[14px] font-medium"
                style={{ color: PALETTE.ink }}
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@studio.com"
                disabled={isBusy}
                className="mb-8 block w-full bg-transparent pb-3 text-[18px] leading-none outline-none placeholder:text-[#6B6B6B] disabled:opacity-60"
                style={{
                  borderBottom: `1px solid ${PALETTE.ink}`,
                  color: PALETTE.ink,
                }}
              />

              <button
                type="submit"
                disabled={gateDisabled}
                className="mb-10 block w-full px-8 py-4 text-[14px] font-medium uppercase transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{
                  backgroundColor: PALETTE.ink,
                  color: PALETTE.bg,
                  letterSpacing: "0.1em",
                }}
              >
                {status.kind === "sending" ? "Sending" : "Send magic link"}
              </button>

              {status.kind === "error" && (
                <p
                  className="mb-6 text-center text-[13px]"
                  style={{ color: "#B91C1C" }}
                >
                  {status.message}
                </p>
              )}
            </form>

            <p
              className="text-center text-[12px] leading-[1.55]"
              style={{ color: PALETTE.muted }}
            >
              Need access, or trouble signing in? Email{" "}
              <a
                href="mailto:hello@hone.care"
                className="underline hover:text-[#0A0A0A]"
              >
                hello@hone.care
              </a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function GoogleGIcon() {
  // Official multicolor Google G. Google's brand guidelines require the
  // multicolor mark when present, so this is the one place the no-color
  // rule yields.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18Z"
        fill="#4285F4"
      />
      <path
        d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2.04c-.72.48-1.64.78-2.7.78-2.07 0-3.83-1.4-4.46-3.28H1.83v2.07A8 8 0 0 0 8.98 17Z"
        fill="#34A853"
      />
      <path
        d="M4.52 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.69-2.07Z"
        fill="#FBBC05"
      />
      <path
        d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4l2.69 2.07a4.77 4.77 0 0 1 4.46-3.29Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function SentNotice({ email }: { email: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p
        className="font-[var(--font-fraunces)] text-[24px] leading-[1.2]"
        style={{ color: PALETTE.ink, letterSpacing: "-0.02em" }}
      >
        Check your email.
      </p>
      <p
        className="text-[16px] leading-[1.55]"
        style={{ color: PALETTE.muted }}
      >
        We sent a sign-in link to{" "}
        <span style={{ color: PALETTE.ink, fontWeight: 500 }}>{email}</span>.
      </p>
      <p
        className="mt-8 text-[12px] leading-[1.55]"
        style={{ color: PALETTE.muted }}
      >
        Didn&rsquo;t get it? Email{" "}
        <a
          href="mailto:hello@hone.care"
          className="underline hover:text-[#0A0A0A]"
        >
          hello@hone.care
        </a>
      </p>
    </div>
  );
}
