"use client";

import { useState } from "react";
import Link from "next/link";
import { requestSignupLinkAction } from "./actions";

const PALETTE = { bg: "#FAFAF7", ink: "#0A0A0A", muted: "#6B6B6B", rule: "#E5E2DA" } as const;

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export function SignupForm({ planSummary }: { planSummary: string | null }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "sending";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: "sending" });
    const r = await requestSignupLinkAction(email);
    setStatus(r.ok ? { kind: "sent" } : { kind: "error", message: r.error });
  }

  return (
    <main
      style={{ backgroundColor: PALETTE.bg, color: PALETTE.ink }}
      className="flex min-h-screen items-center justify-center px-6 font-[var(--font-inter)]"
    >
      <div className="mx-auto w-full max-w-[460px] py-12">
        <h1
          className="font-[var(--font-fraunces)] mb-4 text-center text-[32px] font-bold leading-[1.05]"
          style={{ letterSpacing: "-0.02em" }}
        >
          Create your account
        </h1>
        {planSummary ? (
          <p className="mb-2 text-center text-[14px]" style={{ color: PALETTE.muted }}>
            Selected plan: {planSummary}
          </p>
        ) : null}
        {/* The two things the signup screen must keep apart (Sam, 1 Nov). */}
        <div className="mb-8 border-y py-4 text-[14px] leading-[1.55]" style={{ borderColor: PALETTE.rule }}>
          <p>
            <strong>Creating an account is free and gives no studio access.</strong>
          </p>
          <p style={{ color: PALETTE.muted }}>
            Starting your studio is a separate, paid step. It begins only after your plan is
            confirmed. Existing customers and larger studios use guided onboarding.
          </p>
        </div>

        {status.kind === "sent" ? (
          <p role="status" className="text-center text-[14px] leading-[1.55]">
            Check your email for a link to confirm your address and continue.
          </p>
        ) : (
          <form onSubmit={submit} noValidate>
            <label htmlFor="signup-email" className="mb-2 block text-[13px]">
              Email address
            </label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mb-4 w-full border px-3 py-3 text-[14px]"
              style={{ borderColor: PALETTE.ink, backgroundColor: "#FFFFFF" }}
            />
            {/* PROPOSED neutral line; the exact consent wording is Sam's at activation. */}
            <p className="mb-6 text-[13px] leading-[1.55]" style={{ color: PALETTE.muted }}>
              Hone&rsquo;s{" "}
              <Link href="/terms" target="_blank" rel="noreferrer" className="underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" rel="noreferrer" className="underline">
                Privacy Policy
              </Link>{" "}
              apply.
            </p>
            <button
              type="submit"
              disabled={busy || email.trim().length === 0}
              className="w-full px-6 py-3 text-[14px] font-medium disabled:opacity-50"
              style={{ backgroundColor: PALETTE.ink, color: "#FFFFFF" }}
            >
              {busy ? "Sending" : "Email me a link"}
            </button>
            {status.kind === "error" ? (
              <p role="alert" className="mt-4 text-[13px]">
                {status.message}
              </p>
            ) : null}
          </form>
        )}
      </div>
    </main>
  );
}
