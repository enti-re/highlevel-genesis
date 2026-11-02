import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/errors";
import { HlRequest, runOperation } from "./operations";

const ctx = (impl: (req: HlRequest) => any) => ({ locationId: "loc1", fetch: vi.fn(async (r: HlRequest) => impl(r)) });

describe("HighLevel operations", () => {
  it("injects locationId and normalizes contacts", async () => {
    const c = ctx(() => ({ contacts: [{ id: "c1", firstName: "Ada", lastName: "L", email: null }], total: 41 }));
    const out: any = await runOperation("contacts.list", { limit: 20, query: "ada" }, c);
    expect(c.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/contacts/search",
        body: { locationId: "loc1", pageLimit: 20, page: 1, query: "ada" },
      }),
    );
    expect(out.contacts[0]).toMatchObject({ id: "c1", name: "Ada L", tags: [] });
    expect(out.hasMore).toBe(true);
  });

  it("falls back to the legacy contacts endpoint when search rejects the body", async () => {
    const c = ctx((r) => {
      if (r.path === "/contacts/search") throw new HttpError(422, "HL_BAD_REQUEST", "bad");
      return { contacts: [{ id: "c1", contactName: "Bo" }], meta: { total: 1 } };
    });
    const out: any = await runOperation("contacts.list", {}, c);
    expect(out.contacts[0].name).toBe("Bo");
  });

  it("rejects ids that could inject into the URL path", async () => {
    await expect(
      runOperation(
        "contacts.get",
        { contactId: "../locations/x" },
        ctx(() => ({})),
      ),
    ).rejects.toMatchObject({
      code: "HL_BAD_PARAMS",
    });
  });

  it("rejects unknown operations", async () => {
    await expect(
      runOperation(
        "users.delete",
        {},
        ctx(() => ({})),
      ),
    ).rejects.toMatchObject({ code: "HL_UNKNOWN_OP" });
  });

  it("fans out over calendars when no calendarId is given, and sorts events", async () => {
    const c = ctx((r) => {
      if (r.path === "/calendars/") return { calendars: [{ id: "a" }, { id: "b" }] };
      return {
        events: [{ id: `e-${r.query?.calendarId}`, startTime: r.query?.calendarId === "a" ? "2030-01-02" : "2030-01-01" }],
      };
    });
    const out: any = await runOperation("calendars.events", {}, c);
    expect(out.events.map((e: any) => e.id)).toEqual(["e-b", "e-a"]);
  });

  it("unwraps the nested messages page", async () => {
    const c = ctx(() => ({ messages: { messages: [{ id: "m1", body: "hi" }], nextPage: true, lastMessageId: "m1" } }));
    const out: any = await runOperation("conversations.messages", { conversationId: "conv1" }, c);
    expect(out).toEqual({ messages: [expect.objectContaining({ id: "m1", body: "hi" })], nextCursor: "m1" });
  });

  it("only sends whitelisted contact fields", async () => {
    const c = ctx(() => ({ contact: { id: "n1" } }));
    await runOperation("contacts.create", { contact: { firstName: "A", locationId: "other", dnd: true } }, c);
    expect(c.fetch.mock.calls[0][0].body).toEqual({ firstName: "A", locationId: "loc1" });
  });
});
