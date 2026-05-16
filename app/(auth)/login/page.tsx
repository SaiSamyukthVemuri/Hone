"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

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
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-8 inline-block text-2xl font-semibold tracking-tight"
        >
          Hone
        </Link>

        <h1 className="mb-6 text-2xl font-semibold">Sign in to Hone</h1>

        {status.kind === "sent" ? (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <p className="font-medium">Check your email.</p>
            <p className="mt-1 text-neutral-500">
              We sent a sign-in link to{" "}
              <span className="font-medium">{email}</span>.
            </p>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleGoogle}
              disabled={isBusy}
              className="w-full border border-neutral-900 bg-white px-6 py-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-[#FAFAF7] disabled:opacity-50 md:w-auto"
            >
              {status.kind === "google" ? "Connecting" : "Continue with Google"}
            </button>

            <div className="my-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              <span className="text-[11px] uppercase tracking-[0.2em] text-neutral-500">
                or
              </span>
              <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
            </div>

            <form onSubmit={handleMagicLink} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  placeholder="you@studio.com"
                />
              </label>

              <button
                type="submit"
                disabled={isBusy}
                className="mt-2 rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                {status.kind === "sending" ? "Sending" : "Send magic link"}
              </button>

              {status.kind === "error" && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {status.message}
                </p>
              )}
            </form>

            <p className="mt-8 text-xs text-neutral-500">
              Trouble signing in? Email{" "}
              <a
                href="mailto:hello@hone.care"
                className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
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
