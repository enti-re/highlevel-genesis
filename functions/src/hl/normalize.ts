/** Normalizers: HighLevel payloads -> the small, stable shapes documented to the model in generation/spec.ts. */

export function normalizeContact(c: any) {
  const firstName = c?.firstName ?? c?.firstNameRaw ?? "";
  const lastName = c?.lastName ?? c?.lastNameRaw ?? "";
  const name = c?.contactName ?? c?.name ?? [firstName, lastName].filter(Boolean).join(" ").trim();
  return {
    id: c?.id,
    name: name || c?.email || c?.phone || "Unnamed contact",
    firstName,
    lastName,
    email: c?.email ?? null,
    phone: c?.phone ?? null,
    companyName: c?.companyName ?? null,
    tags: Array.isArray(c?.tags) ? c.tags : [],
    source: c?.source ?? null,
    dateAdded: c?.dateAdded ?? null,
  };
}

export function normalizeEvent(e: any) {
  return {
    id: e?.id,
    title: e?.title ?? "Appointment",
    calendarId: e?.calendarId ?? null,
    contactId: e?.contactId ?? null,
    startTime: e?.startTime ?? null,
    endTime: e?.endTime ?? null,
    status: e?.appointmentStatus ?? null,
    address: e?.address ?? null,
    notes: e?.notes ?? null,
  };
}
