/**
 * Fake HighLevel responses for LOCAL DEVELOPMENT ONLY (MOCK_HL=true in the
 * emulator). Shapes mirror the raw API so the real normalizers are exercised.
 * The deployed app always talks to the real HighLevel API.
 */

import type { HlRequest } from "./operations";

export const MOCK_LOCATION_ID = "mockLocation001";

const day = 24 * 3600 * 1000;
const contacts = [
  ["Aarav", "Sharma", "aarav@example.com", "+919800000001", ["lead"]],
  ["Diya", "Patel", "diya@example.com", "+919800000002", ["customer", "vip"]],
  ["Kabir", "Mehta", "kabir@example.com", "+919800000003", ["lead"]],
  ["Meera", "Iyer", "meera@example.com", "+919800000004", ["customer"]],
  ["Rohan", "Gupta", "rohan@example.com", "+919800000005", []],
].map(([firstName, lastName, email, phone, tags], i) => ({
  id: `mockContact${i + 1}`,
  firstName,
  lastName,
  email,
  phone,
  tags,
  dateAdded: new Date(Date.now() - (i + 1) * day).toISOString(),
}));

export async function mockFetch(req: HlRequest): Promise<any> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (req.path === "/contacts/search") {
    const query = String(req.body?.query ?? "").toLowerCase();
    const list = contacts.filter(
      (contact) => !query || `${contact.firstName} ${contact.lastName} ${contact.email}`.toLowerCase().includes(query),
    );
    return { contacts: list, total: list.length };
  }
  if (req.path.startsWith("/contacts/")) {
    const contact = contacts.find((candidate) => req.path.endsWith(candidate.id)) ?? { id: "mockNew", ...(req.body ?? {}) };
    return { contact: contact };
  }
  if (req.path === "/calendars/") return { calendars: [{ id: "mockCal1", name: "Discovery Call", isActive: true }] };
  if (req.path === "/calendars/events") {
    return {
      events: contacts.slice(0, 3).map((contact, i) => ({
        id: `mockEvent${i}`,
        title: `Discovery call with ${contact.firstName}`,
        calendarId: "mockCal1",
        contactId: contact.id,
        appointmentStatus: "confirmed",
        startTime: new Date(Date.now() + (i + 1) * day).toISOString(),
        endTime: new Date(Date.now() + (i + 1) * day + 1800_000).toISOString(),
      })),
    };
  }
  if (req.path === "/conversations/search") {
    return {
      conversations: contacts.slice(0, 4).map((contact, i) => ({
        id: `mockConv${i}`,
        contactId: contact.id,
        fullName: `${contact.firstName} ${contact.lastName}`,
        lastMessageBody: "Thanks, see you then!",
        lastMessageType: "TYPE_SMS",
        unreadCount: i % 2,
      })),
      total: 4,
    };
  }
  if (req.path.endsWith("/messages")) {
    return {
      messages: {
        messages: [{ id: "m1", body: "Hi! Is Thursday OK?", direction: "inbound", dateAdded: new Date().toISOString() }],
        nextPage: false,
      },
    };
  }
  if (req.path.startsWith("/locations/"))
    return { location: { id: MOCK_LOCATION_ID, name: "Demo Clinic (mock)", timezone: "Asia/Kolkata" } };
  return {};
}
