/**
 * The only HighLevel operations a generated app can call. Each validates params,
 * injects the locationId and normalizes the response to the shapes in generation/spec.ts.
 */

import { HttpError } from "../lib/errors";
import { normalizeContact, normalizeEvent } from "./normalize";
import { contactBody, id, int, optStr, time } from "./params";
import { mapLimit } from "./retry";
import { type OpContext, type Operation, type Params, V_CALENDARS, V_CONTACTS, V_CONVERSATIONS, V_LOCATIONS } from "./types";

export { HL_API_BASE, type HlFetch, type HlRequest, type OpContext } from "./types";
export { normalizeContact } from "./normalize";

const operations: Record<string, Operation> = {
  "location.get": async (_p, ctx) => {
    const data = await ctx.fetch({ method: "GET", path: `/locations/${ctx.locationId}`, version: V_LOCATIONS });
    const l = data?.location ?? {};
    return {
      location: {
        id: l.id ?? ctx.locationId,
        name: l.name ?? null,
        timezone: l.timezone ?? null,
        email: l.email ?? null,
        phone: l.phone ?? null,
        city: l.city ?? null,
        country: l.country ?? null,
      },
    };
  },

  "contacts.list": async (p, ctx) => {
    const limit = int(p, "limit", 1, 100, 20);
    const page = int(p, "page", 1, 1000, 1);
    const query = optStr(p, "query");
    try {
      const data = await ctx.fetch({
        method: "POST",
        path: "/contacts/search",
        version: V_CONTACTS,
        body: { locationId: ctx.locationId, pageLimit: limit, page, ...(query ? { query } : {}) },
      });
      const contacts = (data?.contacts ?? []).map(normalizeContact);
      const total = Number(data?.total ?? contacts.length);
      return { contacts, total, page, hasMore: page * limit < total };
    } catch (err) {
      // Search v2 is the recommended endpoint; fall back to the legacy list
      // endpoint if this location/API version rejects the search body.
      if (!(err instanceof HttpError) || ![400, 422].includes(err.status) || page !== 1) throw err;
      const data = await ctx.fetch({
        method: "GET",
        path: "/contacts/",
        version: V_CONTACTS,
        query: { locationId: ctx.locationId, limit, query },
      });
      const contacts = (data?.contacts ?? []).map(normalizeContact);
      const total = Number(data?.meta?.total ?? data?.count ?? contacts.length);
      return { contacts, total, page: 1, hasMore: contacts.length < total };
    }
  },

  "contacts.get": async (p, ctx) => {
    const data = await ctx.fetch({ method: "GET", path: `/contacts/${id(p, "contactId")}`, version: V_CONTACTS });
    return { contact: normalizeContact(data?.contact) };
  },

  "contacts.create": async (p, ctx) => {
    const body = { ...contactBody(p.contact), locationId: ctx.locationId };
    const data = await ctx.fetch({ method: "POST", path: "/contacts/", version: V_CONTACTS, body });
    return { contact: normalizeContact(data?.contact) };
  },

  "contacts.update": async (p, ctx) => {
    const data = await ctx.fetch({
      method: "PUT",
      path: `/contacts/${id(p, "contactId")}`,
      version: V_CONTACTS,
      body: contactBody(p.contact),
    });
    return { contact: normalizeContact(data?.contact) };
  },

  "conversations.list": async (p, ctx) => {
    const data = await ctx.fetch({
      method: "GET",
      path: "/conversations/search",
      version: V_CONVERSATIONS,
      query: {
        locationId: ctx.locationId,
        limit: int(p, "limit", 1, 100, 20),
        contactId: p.contactId ? id(p, "contactId") : undefined,
        query: optStr(p, "query"),
        sort: "desc",
        sortBy: "last_message_date",
      },
    });
    const conversations = (data?.conversations ?? []).map((c: any) => ({
      id: c.id,
      contactId: c.contactId ?? null,
      contactName: c.contactName ?? c.fullName ?? c.email ?? c.phone ?? "Unknown contact",
      email: c.email ?? null,
      phone: c.phone ?? null,
      lastMessageBody: c.lastMessageBody ?? "",
      lastMessageType: c.lastMessageType ?? null,
      lastMessageDate: c.lastMessageDate ?? c.dateUpdated ?? null,
      unreadCount: Number(c.unreadCount ?? 0),
    }));
    return { conversations, total: Number(data?.total ?? conversations.length) };
  },

  "conversations.messages": async (p, ctx) => {
    const data = await ctx.fetch({
      method: "GET",
      path: `/conversations/${id(p, "conversationId")}/messages`,
      version: V_CONVERSATIONS,
      query: { limit: int(p, "limit", 1, 100, 20), lastMessageId: p.cursor ? id(p, "cursor") : undefined },
    });
    // The live API nests the page under `messages.messages`; the spec documents it flat.
    const page = Array.isArray(data?.messages) ? data : (data?.messages ?? {});
    const messages = (page.messages ?? []).map((m: any) => ({
      id: m.id,
      body: m.body ?? "",
      direction: m.direction ?? null,
      messageType: m.messageType ?? null,
      status: m.status ?? null,
      dateAdded: m.dateAdded ?? null,
    }));
    return { messages, nextCursor: page.nextPage ? (page.lastMessageId ?? null) : null };
  },

  "conversations.sendMessage": async (p, ctx) => {
    const type = optStr(p, "type") ?? "SMS";
    if (!["SMS", "Email", "WhatsApp", "Live_Chat"].includes(type)) {
      throw new HttpError(400, "HL_BAD_PARAMS", '"type" must be SMS, Email, WhatsApp or Live_Chat');
    }
    const message = optStr(p, "message", 2000);
    if (!message) throw new HttpError(400, "HL_BAD_PARAMS", '"message" is required');
    const data = await ctx.fetch({
      method: "POST",
      path: "/conversations/messages",
      version: V_CONVERSATIONS,
      body: {
        type,
        contactId: id(p, "contactId"),
        message,
        ...(type === "Email" ? { subject: optStr(p, "subject") ?? "", html: message } : {}),
      },
    });
    return { messageId: data?.messageId ?? null, conversationId: data?.conversationId ?? null };
  },

  "calendars.list": async (_p, ctx) => {
    const data = await ctx.fetch({
      method: "GET",
      path: "/calendars/",
      version: V_CALENDARS,
      query: { locationId: ctx.locationId },
    });
    const calendars = (data?.calendars ?? []).map((c: any) => ({
      id: c.id,
      name: c.name ?? "Calendar",
      description: c.description ?? null,
      isActive: c.isActive !== false,
      eventType: c.eventType ?? null,
    }));
    return { calendars };
  },

  "calendars.events": async (p, ctx) => {
    const now = Date.now();
    const startTime = time(p, "startTime", now);
    const endTime = time(p, "endTime", startTime + 30 * 24 * 3600 * 1000);
    if (endTime <= startTime) throw new HttpError(400, "HL_BAD_PARAMS", '"endTime" must be after "startTime"');

    // HighLevel requires a calendarId/userId/groupId. If the app didn't pass one,
    // fan out over the location's calendars so "upcoming appointments" just works.
    let calendarIds: string[];
    if (p.calendarId) calendarIds = [id(p, "calendarId")];
    else {
      const { calendars } = (await operations["calendars.list"]({}, ctx)) as { calendars: { id: string }[] };
      calendarIds = calendars.slice(0, 10).map((c) => c.id);
    }
    // At most 3 in flight: HighLevel's burst limit is per location.
    const results = await mapLimit(calendarIds, 3, (calendarId) =>
      ctx.fetch({
        method: "GET",
        path: "/calendars/events",
        version: V_CALENDARS,
        query: { locationId: ctx.locationId, calendarId, startTime, endTime },
      }),
    );
    const events = results
      .flatMap((r) => r?.events ?? [])
      .map(normalizeEvent)
      .sort((a, b) => Date.parse(a.startTime ?? 0) - Date.parse(b.startTime ?? 0));
    const limit = int(p, "limit", 1, 200, 50);
    return { events: events.slice(0, limit) };
  },

  "calendars.freeSlots": async (p, ctx) => {
    const startDate = time(p, "startDate", Date.now());
    const endDate = time(p, "endDate", startDate + 7 * 24 * 3600 * 1000);
    const data = await ctx.fetch({
      method: "GET",
      path: `/calendars/${id(p, "calendarId")}/free-slots`,
      version: V_CALENDARS,
      query: { startDate, endDate, timezone: optStr(p, "timezone") },
    });
    const days = Object.entries(data ?? {})
      .filter(([date, v]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray((v as any)?.slots))
      .map(([date, v]) => ({ date, slots: (v as any).slots as string[] }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { days };
  },
};

export const OPERATION_NAMES = Object.keys(operations);

export async function runOperation(op: string, params: Params, ctx: OpContext) {
  const fn = operations[op];
  if (!fn) throw new HttpError(400, "HL_UNKNOWN_OP", `Unknown HighLevel operation "${op}"`);
  return fn(params ?? {}, ctx);
}
