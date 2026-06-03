"use client";

import { useState, useTransition } from "react";
import { requestPortalMagicLinkAction } from "./actions";

// Client portal login form. Single email field; submit posts to the
// server action which always returns a generic success message on a
// well-formed request. The page renders the action result inline so
// the visitor sees the same string regardless of whether a match
// existed, satisfying the no-enumeration guarantee.
export function PortalLoginForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setError(null);
    const fd = new FormData();
    fd.set("email", email);
    startTransition(async () => {
      const r = await requestPortalMagicLinkAction(fd);
      if (r.ok) {
        setMessage(r.message);
        // Clear the input so the visitor cannot resubmit the same
        // address quickly enough to learn anything from latency.
        setEmail("");
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Email
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          placeholder="name@example.com"
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </label>
      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {pending ? "Sending…" : "Send secure link"}
        </button>
        {message && (
          <p
            className="text-[14px] leading-relaxed"
            style={{ color: "#0A0A0A" }}
            role="status"
          >
            {message}
          </p>
        )}
        {error && (
          <p className="text-[13px] text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
