/** Normalizers: HighLevel payloads -> the small, stable shapes documented to the model in generation/spec.ts. */

export function normalizeContact(contact: any) {
  const firstName = contact?.firstName ?? contact?.firstNameRaw ?? "";
  const lastName = contact?.lastName ?? contact?.lastNameRaw ?? "";
  const name = contact?.contactName ?? contact?.name ?? [firstName, lastName].filter(Boolean).join(" ").trim();
  return {
    id: contact?.id,
    name: name || contact?.email || contact?.phone || "Unnamed contact",
    firstName,
    lastName,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    companyName: contact?.companyName ?? null,
    tags: Array.isArray(contact?.tags) ? contact.tags : [],
    source: contact?.source ?? null,
    dateAdded: contact?.dateAdded ?? null,
  };
}

export function normalizeEvent(event: any) {
  return {
    id: event?.id,
    title: event?.title ?? "Appointment",
    calendarId: event?.calendarId ?? null,
    contactId: event?.contactId ?? null,
    startTime: event?.startTime ?? null,
    endTime: event?.endTime ?? null,
    status: event?.appointmentStatus ?? null,
    address: event?.address ?? null,
    notes: event?.notes ?? null,
  };
}
