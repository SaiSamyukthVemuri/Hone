"use client";
import { useState } from "react";
import Link from "next/link";
import { startOwnerSignIn, confirmOwnerCode } from "./actions";
import { PLANS, teamAllowance, type PlanKey } from "@/lib/subscriptions/plans";

export function SignupForm({ plan }: { plan: PlanKey | null }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(method: "google" | "email" | "code") {
    setBusy(true);
    setMessage("");
    try {
      const result =
        method === "code"
          ? await confirmOwnerCode(plan ?? "signin", email, code.trim())
          : await startOwnerSignIn(
              plan ?? "signin",
              method === "email" ? email : undefined,
            );
      if (!result.ok) setMessage(result.error);
      else if (result.destination) window.location.assign(result.destination);
      else {
        setSent(true);
        setCode("");
        setMessage("Check your email for your sign-in code.");
      }
    } catch {
      setMessage("We couldn’t reach Hone. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto grid min-h-screen max-w-md content-center gap-5 px-6">
      <h1 className="text-3xl font-semibold">
        {plan ? "Start your studio" : "Sign in to your studio"}
      </h1>
      {plan && (
        <div>
          <strong>
            {PLANS[plan].label} · US${PLANS[plan].unitAmount / 100}/month
          </strong>
          <p>{teamAllowance(plan)}</p>
          <Link href="/pricing" className="underline">
            Change plan
          </Link>
        </div>
      )}
      {plan && (
        <p>
          Sign in to manage your studio. Your subscription starts when you pay.
        </p>
      )}
      <button
        className="rounded border px-4 py-3"
        disabled={busy}
        onClick={() => submit("google")}
      >
        Continue with Google
      </button>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(sent ? "code" : "email");
        }}
      >
        <label>
          Email address
          <input
            className="block w-full rounded border p-2"
            type="email"
            autoComplete="email"
            required
            readOnly={sent}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {sent && (
          <label>
            Email code
            <input
              className="block w-full rounded border p-2"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{6,10}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        )}
        <button
          disabled={busy}
          className="rounded bg-neutral-900 px-4 py-3 text-white"
        >
          {sent ? "Continue" : "Send me a code"}
        </button>
        {sent && (
          <div className="flex gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => submit("email")}
            >
              Resend code
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSent(false);
                setCode("");
                setMessage("");
              }}
            >
              Change email
            </button>
          </div>
        )}
      </form>
      <p role="status">{message}</p>
      <p className="text-sm">
        Hone’s{" "}
        <Link href="/terms" className="underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>{" "}
        apply.
      </p>
    </main>
  );
}
