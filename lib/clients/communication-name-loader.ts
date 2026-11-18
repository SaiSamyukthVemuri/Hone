// HON-58: the name a client email carries for the client is the communication name (preferred, else stored), loaded at the SEND
// boundary, right before the message is built. The send never depends on the read: any failure, a missing preferred-name column, no
// preferred name, or a read that is slow, returns the stored name the caller already holds, which is today's text.

import { clientCommunicationName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import { loadTreatmentTimeNameFields } from "@/lib/treatment-time/client-first-name";

/** A bound on the read so a slow database cannot hold an email. */
export const COMMUNICATION_NAME_READ_TIMEOUT_MS = 2500;

async function withTimeout<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The communication name of one client in one studio, or the stored name on any failure. Never throws. */
export async function loadCommunicationName(
  admin: unknown,
  studioId: string,
  clientId: string | null | undefined,
  storedName: string,
  timeoutMs: number = COMMUNICATION_NAME_READ_TIMEOUT_MS,
): Promise<string> {
  if (!clientId) return storedName;
  return withTimeout(
    loadTreatmentTimeNameFields(admin, studioId, clientId, storedName).then((f) => clientCommunicationName(f)),
    storedName,
    timeoutMs,
  );
}

type AppointmentClientRead = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        eq: (column: string, value: string) => {
          maybeSingle: () => PromiseLike<{
            data: { client?: { name?: string | null; preferred_name?: string | null } | { name?: string | null; preferred_name?: string | null }[] | null } | null;
            error: { code?: string | null; message?: string | null } | null;
          }>;
        };
      };
    };
  };
};

/** The same, for a sender that holds an appointment id and no client id (the cancellation email). Studio-scoped. Never throws. */
export async function loadCommunicationNameForAppointment(
  admin: unknown,
  studioId: string,
  appointmentId: string,
  storedName: string | null,
  timeoutMs: number = COMMUNICATION_NAME_READ_TIMEOUT_MS,
): Promise<string | null> {
  if (!storedName) return storedName;
  return withTimeout<string | null>(
    (async () => {
      const { data, error } = await readWithPreferredName((includePreferred) =>
        (admin as AppointmentClientRead)
          .from("appointments")
          .select(`client:clients(${preferredNameColumn(includePreferred)}name)`)
          .eq("id", appointmentId)
          .eq("studio_id", studioId)
          .maybeSingle(),
      );
      if (error || !data) return storedName;
      const client = Array.isArray(data.client) ? data.client[0] : data.client;
      if (!client) return storedName;
      return clientCommunicationName({ name: storedName, preferred_name: client.preferred_name ?? null });
    })(),
    storedName,
    timeoutMs,
  );
}
