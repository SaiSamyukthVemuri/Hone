"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

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

  async function handleGoogle() {
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
    setStatus({ kind: "sending" });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
    } else {
      setStatus({ kind: "sent" });
    }
  }

  const isBusy = status.kind === "google" || status.kind === "sending";

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="flex min-h-screen flex-col items-center justify-center px-6 py-16 font-[var(--font-inter)]"
    >
      <div className="w-full max-w-[420px]">
        <Link
          href="/"
          className="font-[var(--font-fraunces)] mb-12 inline-block text-[28px] font-bold leading-none"
          style={{ letterSpacing: "-0.02em", color: PALETTE.ink }}
        >
          Hone
        </Link>

        <h1
          className="font-[var(--font-fraunces)] mb-12 text-[40px] font-bold leading-[0.95] md:text-[48px]"
          style={{ letterSpacing: "-0.03em", color: PALETTE.ink }}
        >
          Sign in to Hone
        </h1>

        {status.kind === "sent" ? (
          <SentNotice email={email} />
        ) : (
          <>
            <button
              type="button"
              onClick={handleGoogle}
              disabled={isBusy}
              className="w-full px-6 py-3 text-[14px] font-medium transition-colors disabled:opacity-50 md:w-auto md:min-w-[260px]"
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
              {status.kind === "google" ? "Connecting" : "Continue with Google"}
            </button>

            <div className="my-10 flex items-center gap-4">
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

            <form onSubmit={handleMagicLink} className="flex flex-col gap-8">
              <label className="flex flex-col gap-3">
                <span
                  className="text-[14px] font-medium"
                  style={{ color: PALETTE.ink }}
                >
                  Email
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@studio.com"
                  disabled={isBusy}
                  className="bg-transparent pb-3 text-[18px] leading-none outline-none placeholder:text-[#6B6B6B] disabled:opacity-60"
                  style={{
                    borderBottom: `1px solid ${PALETTE.ink}`,
                    color: PALETTE.ink,
                  }}
                />
              </label>

              <button
                type="submit"
                disabled={isBusy}
                className="w-full px-8 py-4 text-[14px] font-medium uppercase transition-opacity hover:opacity-90 disabled:opacity-50 md:w-auto md:min-w-[260px]"
                style={{
                  backgroundColor: PALETTE.ink,
                  color: PALETTE.bg,
                  letterSpacing: "0.1em",
                }}
              >
                {status.kind === "sending" ? "Sending" : "Send magic link"}
              </button>

              {status.kind === "error" && (
                <p className="text-[13px]" style={{ color: "#B91C1C" }}>
                  {status.message}
                </p>
              )}
            </form>

            <p
              className="mt-12 text-[12px] leading-[1.55]"
              style={{ color: PALETTE.muted }}
            >
              Trouble signing in? Email{" "}
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

function SentNotice({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-3">
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
