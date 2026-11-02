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
  await new Promise((r) => setTimeout(r, 150));
  if (req.path === "/contacts/search") {
    const q = String(req.body?.query ?? "").toLowerCase();
    const list = contacts.filter((c) => !q || `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(q));
    return { contacts: list, total: list.length };
  }
  if (req.path.startsWith("/contacts/")) {
    const c = contacts.find((x) => req.path.endsWith(x.id)) ?? { id: "mockNew", ...(req.body ?? {}) };
    return { contact: c };
  }
  if (req.path === "/calendars/") return { calendars: [{ id: "mockCal1", name: "Discovery Call", isActive: true }] };
  if (req.path === "/calendars/events") {
    return {
      events: contacts.slice(0, 3).map((c, i) => ({
        id: `mockEvent${i}`,
        title: `Discovery call with ${c.firstName}`,
        calendarId: "mockCal1",
        contactId: c.id,
        appointmentStatus: "confirmed",
        startTime: new Date(Date.now() + (i + 1) * day).toISOString(),
        endTime: new Date(Date.now() + (i + 1) * day + 1800_000).toISOString(),
      })),
    };
  }
  if (req.path === "/conversations/search") {
    return {
      conversations: contacts.slice(0, 4).map((c, i) => ({
        id: `mockConv${i}`,
        contactId: c.id,
        fullName: `${c.firstName} ${c.lastName}`,
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
