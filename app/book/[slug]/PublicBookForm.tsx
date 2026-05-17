"use client";

import { useEffect, useState, useTransition } from "react";
import type { Service } from "@/lib/types/database";
import { fetchPublicSlotsAction, publicBookAppointmentAction } from "./actions";

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  slug: string;
  services: Service[];
  defaultDate: string;
};

export function PublicBookForm({ slug, services, defaultDate }: Props) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ when: string } | null>(null);
  const [loadingSlots, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();

  // Single source of truth for the slots fetch: re-runs only when slug,
  // serviceId, or date actually change. Race-safe via a cancellation flag.
  useEffect(() => {
    if (!serviceId || !date) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setError(null);
    setPicked(null);
    startLoading(async () => {
      const r = await fetchPublicSlotsAction({ slug, serviceId, date });
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        return;
      }
      setSlots(r.slots);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, serviceId, date]);

  function onService(v: string) {
    setServiceId(v);
  }
  function onDate(v: string) {
    setDate(v);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) {
      setError("Pick a time first.");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("service_id", serviceId);
    fd.set("starts_at", picked.start);
    fd.set("name", name);
    fd.set("email", email);
    fd.set("phone", phone);
    fd.set("notes", notes);
    startSubmitting(async () => {
      const r = await publicBookAppointmentAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({ when: picked.startLabel });
    });
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h2
          className="font-[var(--font-fraunces)] text-[28px] font-bold leading-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          You&rsquo;re booked.
        </h2>
        <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
          We sent a confirmation to <strong>{email}</strong>. Check your inbox
          for the appointment details and a calendar invite. If you don&rsquo;t
          see it, check spam.
        </p>
      </div>
    );
  }

  if (services.length === 0) {
    return (
      <p className="text-sm text-[#6B6B6B]">
        This studio isn&rsquo;t accepting bookings yet. Please reach out
        directly.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-8">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Service">
          <select
            value={serviceId}
            onChange={(e) => onService(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.default_duration_minutes} min)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => onDate(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Available times
        </span>
        {loadingSlots ? (
          <p className="text-sm text-[#6B6B6B]">Loading slots…</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-[#6B6B6B]">No availability on that date.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => {
              const sel = picked?.start === s.start;
              return (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => setPicked(s)}
                  className={`px-4 py-2 text-sm transition ${
                    sel
                      ? "bg-[#0A0A0A] text-[#FAFAF7]"
                      : "bg-white text-[#0A0A0A] hover:bg-[#F5F2EB]"
                  }`}
                  style={{ border: "1px solid #0A0A0A" }}
                >
                  {s.startLabel}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Your name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

      <Field label="Phone (optional)">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      <Field label="Anything else?">
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {submitting ? "Booking…" : "Book appointment"}
        </button>
        {error && (
          <span className="text-[13px] text-red-600">{error}</span>
        )}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
