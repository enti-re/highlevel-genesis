/**
 * The only HighLevel operations a generated app can call. Each validates params,
 * injects the locationId and normalizes the response to the shapes in generation/spec.ts.
 */

import { HttpError } from "../lib/errors";
import { normalizeContact, normalizeEvent } from "./normalize";
import { contactBody, id, int, optStr, time } from "./params";
import { mapLimit } from "./retry";
import { type OpContext, type Operation, type Params, V_CALENDARS, V_CONTACTS, V_CONVERSATIONS, V_LOCATIONS } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1000;
const MAX_MESSAGE_CHARS = 2000;
const DEFAULT_EVENTS = 50;
const MAX_EVENTS = 200;
const DEFAULT_EVENTS_WINDOW_DAYS = 30;
const DEFAULT_FREE_SLOTS_WINDOW_DAYS = 7;
/** HighLevel's burst limit is per location, so calendar fan-out stays small. */
const CALENDAR_FANOUT_CONCURRENCY = 3;
const MAX_FANOUT_CALENDARS = 10;

export { HL_API_BASE, type HlFetch, type HlRequest, type OpContext } from "./types";
export { normalizeContact } from "./normalize";

const operations: Record<string, Operation> = {
  "location.get": async (_p, ctx) => {
    const data = await ctx.fetch({ method: "GET", path: `/locations/${ctx.locationId}`, version: V_LOCATIONS });
    const location = data?.location ?? {};
    return {
      location: {
        id: location.id ?? ctx.locationId,
        name: location.name ?? null,
        timezone: location.timezone ?? null,
        email: location.email ?? null,
        phone: location.phone ?? null,
        city: location.city ?? null,
        country: location.country ?? null,
      },
    };
  },

  "contacts.list": async (params, ctx) => {
    const limit = int(params, "limit", 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const page = int(params, "page", 1, MAX_PAGE, 1);
    const query = optStr(params, "query");
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

  "contacts.get": async (params, ctx) => {
    const data = await ctx.fetch({ method: "GET", path: `/contacts/${id(params, "contactId")}`, version: V_CONTACTS });
    return { contact: normalizeContact(data?.contact) };
  },

  "contacts.create": async (params, ctx) => {
    const body = { ...contactBody(params.contact), locationId: ctx.locationId };
    const data = await ctx.fetch({ method: "POST", path: "/contacts/", version: V_CONTACTS, body });
    return { contact: normalizeContact(data?.contact) };
  },

  "contacts.update": async (params, ctx) => {
    const data = await ctx.fetch({
      method: "PUT",
      path: `/contacts/${id(params, "contactId")}`,
      version: V_CONTACTS,
      body: contactBody(params.contact),
    });
    return { contact: normalizeContact(data?.contact) };
  },

  "conversations.list": async (params, ctx) => {
    const data = await ctx.fetch({
      method: "GET",
      path: "/conversations/search",
      version: V_CONVERSATIONS,
      query: {
        locationId: ctx.locationId,
        limit: int(params, "limit", 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
        contactId: params.contactId ? id(params, "contactId") : undefined,
        query: optStr(params, "query"),
        sort: "desc",
        sortBy: "last_message_date",
      },
    });
    const conversations = (data?.conversations ?? []).map((conversation: any) => ({
      id: conversation.id,
      contactId: conversation.contactId ?? null,
      contactName: conversation.contactName ?? conversation.fullName ?? conversation.email ?? conversation.phone ?? "Unknown contact",
      email: conversation.email ?? null,
      phone: conversation.phone ?? null,
      lastMessageBody: conversation.lastMessageBody ?? "",
      lastMessageType: conversation.lastMessageType ?? null,
      lastMessageDate: conversation.lastMessageDate ?? conversation.dateUpdated ?? null,
      unreadCount: Number(conversation.unreadCount ?? 0),
    }));
    return { conversations, total: Number(data?.total ?? conversations.length) };
  },

  "conversations.messages": async (params, ctx) => {
    const data = await ctx.fetch({
      method: "GET",
      path: `/conversations/${id(params, "conversationId")}/messages`,
      version: V_CONVERSATIONS,
      query: {
        limit: int(params, "limit", 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
        lastMessageId: params.cursor ? id(params, "cursor") : undefined,
      },
    });
    // The live API nests the page under `messages.messages`; the spec documents it flat.
    const page = Array.isArray(data?.messages) ? data : (data?.messages ?? {});
    const messages = (page.messages ?? []).map((message: any) => ({
      id: message.id,
      body: message.body ?? "",
      direction: message.direction ?? null,
      messageType: message.messageType ?? null,
      status: message.status ?? null,
      dateAdded: message.dateAdded ?? null,
    }));
    return { messages, nextCursor: page.nextPage ? (page.lastMessageId ?? null) : null };
  },

  "conversations.sendMessage": async (params, ctx) => {
    const type = optStr(params, "type") ?? "SMS";
    if (!["SMS", "Email", "WhatsApp", "Live_Chat"].includes(type)) {
      throw new HttpError(400, "HL_BAD_PARAMS", '"type" must be SMS, Email, WhatsApp or Live_Chat');
    }
    const message = optStr(params, "message", MAX_MESSAGE_CHARS);
    if (!message) throw new HttpError(400, "HL_BAD_PARAMS", '"message" is required');
    const data = await ctx.fetch({
      method: "POST",
      path: "/conversations/messages",
      version: V_CONVERSATIONS,
      body: {
        type,
        contactId: id(params, "contactId"),
        message,
        ...(type === "Email" ? { subject: optStr(params, "subject") ?? "", html: message } : {}),
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
    const calendars = (data?.calendars ?? []).map((calendar: any) => ({
      id: calendar.id,
      name: calendar.name ?? "Calendar",
      description: calendar.description ?? null,
      isActive: calendar.isActive !== false,
      eventType: calendar.eventType ?? null,
    }));
    return { calendars };
  },

  "calendars.events": async (params, ctx) => {
    const now = Date.now();
    const startTime = time(params, "startTime", now);
    const endTime = time(params, "endTime", startTime + DEFAULT_EVENTS_WINDOW_DAYS * DAY_MS);
    if (endTime <= startTime) throw new HttpError(400, "HL_BAD_PARAMS", '"endTime" must be after "startTime"');

    // HighLevel requires a calendarId/userId/groupId. If the app didn't pass one,
    // fan out over the location's calendars so "upcoming appointments" just works.
    let calendarIds: string[];
    if (params.calendarId) calendarIds = [id(params, "calendarId")];
    else {
      const { calendars } = (await operations["calendars.list"]({}, ctx)) as { calendars: { id: string }[] };
      calendarIds = calendars.slice(0, MAX_FANOUT_CALENDARS).map((calendar) => calendar.id);
    }
    // At most 3 in flight: HighLevel's burst limit is per location.
    const results = await mapLimit(calendarIds, CALENDAR_FANOUT_CONCURRENCY, (calendarId) =>
      ctx.fetch({
        method: "GET",
        path: "/calendars/events",
        version: V_CALENDARS,
        query: { locationId: ctx.locationId, calendarId, startTime, endTime },
      }),
    );
    const events = results
      .flatMap((response) => response?.events ?? [])
      .map(normalizeEvent)
      .sort((a, b) => Date.parse(a.startTime ?? 0) - Date.parse(b.startTime ?? 0));
    const limit = int(params, "limit", 1, MAX_EVENTS, DEFAULT_EVENTS);
    return { events: events.slice(0, limit) };
  },

  "calendars.freeSlots": async (params, ctx) => {
    const startDate = time(params, "startDate", Date.now());
    const endDate = time(params, "endDate", startDate + DEFAULT_FREE_SLOTS_WINDOW_DAYS * DAY_MS);
    const data = await ctx.fetch({
      method: "GET",
      path: `/calendars/${id(params, "calendarId")}/free-slots`,
      version: V_CALENDARS,
      query: { startDate, endDate, timezone: optStr(params, "timezone") },
    });
    const days = Object.entries(data ?? {})
      .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray((value as any)?.slots))
      .map(([date, value]) => ({ date, slots: (value as any).slots as string[] }))
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
