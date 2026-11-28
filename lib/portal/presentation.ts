export const portalSectionIds = ["appointments", "tasks", "booking", "care", "records", "payment"] as const;
export type PortalSectionId = (typeof portalSectionIds)[number];

export type PortalSection = {
  id: PortalSectionId;
  title: string;
  description: string;
  visible: boolean;
};

export type PortalPresentation = {
  ownerName: string;
  welcomeHeading: string;
  welcomeMessage: string;
  sections: PortalSection[];
};

const titles: Record<PortalSectionId, string> = {
  appointments: "Your next appointment",
  tasks: "Before your visit",
  booking: "Book another appointment",
  care: "Care guide",
  records: "Forms & records",
  payment: "Payment method",
};

export function defaultPortalPresentation(): PortalPresentation {
  return {
    ownerName: "",
    welcomeHeading: "Hello, {client}.",
    welcomeMessage: "Your visits and care at {studio}.",
    sections: portalSectionIds.map((id) => ({ id, title: titles[id], description: "", visible: true })),
  };
}

export function formatPortalCopy(
  text: string,
  names: { ownerName: string; studioName: string; clientName: string },
): string {
  const values = { owner: names.ownerName.trim() || names.studioName, studio: names.studioName, client: names.clientName };
  return text.replace(/\{(owner|studio|client)\}/g, (_, key: keyof typeof values) => values[key]);
}

export const portalCopyLimits = { owner: 80, title: 120, description: 600 } as const;

function boundedText(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || Boolean(value.trim()));
}

/** Validate at both entry points. The stored document can outlive the app that wrote it. */
export function parsePortalPresentation(raw: unknown): PortalPresentation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!boundedText(value.ownerName, portalCopyLimits.owner) ||
      !boundedText(value.welcomeHeading, portalCopyLimits.title, true) ||
      !boundedText(value.welcomeMessage, portalCopyLimits.description) ||
      !Array.isArray(value.sections) || value.sections.length !== portalSectionIds.length) return null;

  const sections: PortalSection[] = [];
  for (const item of value.sections) {
    if (!item || !portalSectionIds.includes(item.id) || sections.some((s) => s.id === item.id) ||
        !boundedText(item.title, portalCopyLimits.title, true) ||
        !boundedText(item.description, portalCopyLimits.description) || typeof item.visible !== "boolean") return null;
    sections.push({ id: item.id, title: item.title.trim(), description: item.description.trim(), visible: item.visible });
  }
  return {
    ownerName: value.ownerName.trim(), welcomeHeading: value.welcomeHeading.trim(),
    welcomeMessage: value.welcomeMessage.trim(), sections,
  };
}
