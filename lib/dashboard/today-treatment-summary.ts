import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

/**
 * The compact identity of the previous visit for the Today row: when, what
 * modality, which areas, how long.
 *
 * Pure, and deliberately in its own module rather than beside the component:
 * the repo's unit lane runs `environment: "node"` with no JSX transform, so
 * logic that lives inside a `.tsx` cannot be tested behaviourally at all. The
 * truthfulness rule below is exactly the kind that must not degrade to a source
 * grep.
 *
 * THE RULE. Every part is optional, because the historical record genuinely may
 * not carry it. Absent values are OMITTED; they are never rendered as "0 min",
 * "0 hairs" or an empty area. A legacy visit with no recorded minutes did not
 * take zero minutes. The model already distinguishes "not recorded" from
 * "recorded as zero" — totalMinutes is `null` vs `0` — and this preserves that
 * distinction rather than flattening it with a falsy check.
 */
export function compactSummary(memory: AppointmentPrepMemory): string {
  const date = new Date(memory.startedAt);
  const parts: string[] = [
    Number.isNaN(date.getTime())
      ? "Date not recorded"
      : date.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
  ];
  if (memory.modality) parts.push(memory.modality);
  if (memory.areaHeadline) parts.push(memory.areaHeadline);
  // `!= null` on purpose: 0 is a real measurement and must survive.
  if (memory.totalMinutes != null) parts.push(`${memory.totalMinutes} min`);
  return parts.join(" · ");
}
