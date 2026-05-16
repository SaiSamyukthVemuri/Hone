"use client";

import { useState, useTransition } from "react";
import { submitWaitlistEntry } from "@/app/actions/waitlist";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "fading" }
  | { kind: "done" };

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "submitting" || status.kind === "fading") return;

    setStatus({ kind: "submitting" });

    startTransition(async () => {
      const result = await submitWaitlistEntry(email);
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error });
        return;
      }

      // Fade out the form, then swap in the confirmation line.
      setStatus({ kind: "fading" });
      window.setTimeout(() => setStatus({ kind: "done" }), 220);
    });
  }

  if (status.kind === "done") {
    return (
      <p className="font-[var(--font-inter)] text-[18px] leading-[1.55] text-[#0A0A0A] md:text-[21px]">
        Thanks. We&rsquo;ll be in touch when we&rsquo;re ready for you.
      </p>
    );
  }

  const isFading = status.kind === "fading";

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        opacity: isFading ? 0 : 1,
        transition: "opacity 200ms ease-out",
      }}
      noValidate
    >
      <div className="flex items-end gap-6 border-b border-[#0A0A0A] pb-[14px]">
        <input
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status.kind === "submitting" || isFading}
          className="flex-1 bg-transparent text-[20px] leading-none text-[#0A0A0A] outline-none placeholder:text-[#6B6B6B] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={status.kind === "submitting" || isFading}
          className="font-[var(--font-inter)] text-[13px] font-medium uppercase tracking-[0.2em] text-[#0A0A0A] transition-opacity hover:opacity-60 disabled:opacity-40"
        >
          {status.kind === "submitting" ? "Sending" : "Submit"}
        </button>
      </div>
      {status.kind === "error" && (
        <p className="mt-3 font-[var(--font-inter)] text-[13px] text-[#6B6B6B]">
          {status.message}
        </p>
      )}
    </form>
  );
}
