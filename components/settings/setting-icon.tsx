import type { ReactNode } from "react";

const shapes: Record<string, ReactNode> = {
  "Settings overview": <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  "Booking & availability": <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h4"/></>,
  "Messages": <><path d="M20 13a3 3 0 0 1-3 3h-6l-6 4v-4a3 3 0 0 1-2-3V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/><path d="M7 8h9m-9 4h6"/></>,
  "Payments & fees": <><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3 10h18M7 15h3"/></>,
  "Client forms & care": <><path d="M7 3h8l4 4v14H5V3zM14 3v5h5m-11 4h7m-7 4h7"/></>,
  "Studio & team": <><path d="M3 10h18l-2-6H5zM5 10v10h14V10m-9 10v-6h4v6"/></>,
  "Services & machines": <><path d="M3 7h18M3 17h18"/><circle cx="9" cy="7" r="2.7" fill="white"/><circle cx="16" cy="17" r="2.7" fill="white"/></>,
  "Connections & data": <><ellipse cx="12" cy="5.5" rx="8.5" ry="3.5"/><path d="M3.5 5.5V18c0 2 4 3.5 8.5 3.5s8.5-1.5 8.5-3.5V5.5M3.5 12c0 2 4 3.5 8.5 3.5s8.5-1.5 8.5-3.5"/></>,
  "My profile": <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  "Search": <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
};

export function SettingIcon({ name }: { name: string }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    {shapes[name] ?? shapes["Settings overview"]}
  </svg>;
}
