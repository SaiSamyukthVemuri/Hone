"use client";

import { useState, useTransition } from "react";
import { publicCancelAppointmentAction } from "./actions";

type Props = {
  token: string;
  alreadyCancelled: boolean;
};

export function CancelForm({ token, alreadyCancelled }: Props) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"cancelled" | "already" | null>(
    alreadyCancelled ? "already" : null,
  );

  if (done === "cancelled") {
    return (
      <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
        Your appointment is cancelled. We&rsquo;ve let the studio know.
      </p>
    );
  }
  if (done === "already") {
    return (
      <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
        This appointment was already cancelled. No further action needed.
      </p>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("reason", reason);
    startTransition(async () => {
      const r = await publicCancelAppointmentAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone(r.alreadyCancelled ? "already" : "cancelled");
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Reason (optional)
        </span>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </label>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {pending ? "Cancelling…" : "Cancel appointment"}
        </button>
        {error && <span className="text-[13px] text-red-600">{error}</span>}
      </div>
    </form>
  );
}
