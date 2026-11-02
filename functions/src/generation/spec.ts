/**
 * The `window.hl` contract, as documented to the model. This is the ONLY
 * HighLevel surface the model learns about - it never sees raw endpoints, so
 * it can't invent URLs or try to handle tokens. Keep in sync with
 * hl/operations.ts (server) and frontend/src/preview/hlRuntime.ts (iframe).
 */
export const HL_CLIENT_SPEC = `
## window.hl - HighLevel data client (already loaded in the preview, do not define it)

Every method returns a Promise. On failure it rejects with an \`HLError\`:
\`{ name: "HLError", code: string, message: string, status: number, retryable: boolean }\`.
Common codes: HL_NOT_CONNECTED (user must connect HighLevel), HL_RECONNECT, HL_FORBIDDEN (missing scope),
HL_RATE_LIMITED (retryable), HL_UNAVAILABLE (retryable), HL_TIMEOUT (retryable), HL_BAD_PARAMS.
Dates come back as ISO strings. Any field may be null.

### Location
hl.location.get() -> { location: { id, name, timezone, email, phone, city, country } }

### Contacts
type Contact = { id, name, firstName, lastName, email, phone, companyName, tags: string[], source, dateAdded }
hl.contacts.list({ query?, limit? = 20 (max 100), page? = 1 })
  -> { contacts: Contact[], total: number, page: number, hasMore: boolean }
hl.contacts.listAll({ query?, max? = 200 })  -> { contacts: Contact[], total }   // follows pagination for you
hl.contacts.get({ contactId })               -> { contact: Contact }
hl.contacts.create({ contact: { firstName?, lastName?, name?, email?, phone?, companyName?, tags?, source? } })
  -> { contact: Contact }
hl.contacts.update({ contactId, contact: { ...same fields as create } }) -> { contact: Contact }

### Conversations
type Conversation = { id, contactId, contactName, email, phone, lastMessageBody, lastMessageType, lastMessageDate, unreadCount }
type Message = { id, body, direction: "inbound" | "outbound", messageType, status, dateAdded }
hl.conversations.list({ query?, contactId?, limit? = 20 }) -> { conversations: Conversation[], total }
hl.conversations.messages({ conversationId, limit? = 20, cursor? }) -> { messages: Message[], nextCursor: string | null }
hl.conversations.sendMessage({ contactId, message, type? = "SMS" | "Email", subject? }) -> { messageId, conversationId }

### Calendars
type Calendar = { id, name, description, isActive, eventType }
type Appointment = { id, title, calendarId, contactId, startTime, endTime, status, address, notes }
hl.calendars.list() -> { calendars: Calendar[] }
hl.calendars.events({ startTime?, endTime?, calendarId?, limit? = 50 })
  -> { events: Appointment[] }   // sorted ascending. startTime/endTime: ms epoch or ISO.
                                 // Defaults: now .. now+30 days. Omit calendarId to include all calendars.
hl.calendars.freeSlots({ calendarId, startDate?, endDate?, timezone? }) -> { days: { date: "YYYY-MM-DD", slots: string[] }[] }
`.trim();
