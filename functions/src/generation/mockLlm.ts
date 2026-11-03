import type Anthropic from "@anthropic-ai/sdk";
import type { LlmChunk, LlmResult } from "./llm";

/**
 * Emulator only (MOCK_LLM=true): streams a canned dashboard. Prompt triggers for tests:
 * "fail" drops the stream mid-file,
 * "rename" for a search/replace edit, "mismatch" for an edit that can't apply
 * (repaired by a full rewrite), "mismatch norepair" for one that stays failed.
 */
const APP = `I'll build a contacts dashboard with search and an upcoming appointments panel.
<file path="index.html">
<!doctype html>
<html lang="en">
<head>
  <title>Contacts Dashboard</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>
</file>
<file path="app.js">
const { createApp, ref, watch } = Vue;

const TEMPLATE = \`
<main class="min-h-screen bg-background text-foreground">
  <div class="mx-auto max-w-5xl p-6 grid gap-4 md:grid-cols-2">
    <section class="rounded-xl border border-border bg-card shadow-sm">
      <header class="flex items-center justify-between gap-2 border-b p-4">
        <h2 class="font-semibold">Contacts</h2>
        <div class="relative w-48">
          <g-icon name="search" class="absolute left-2.5 top-2.5 text-muted-foreground" />
          <input v-model="query" placeholder="Search contacts..."
            class="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </header>
      <div class="p-4">
        <div v-if="contacts.loading.value" class="space-y-2"><div v-for="i in 4" :key="i" class="h-10 animate-pulse rounded-md bg-muted"></div></div>
        <div v-else-if="contacts.error.value" class="error rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {{ genesis.errorText(contacts.error.value) }}
          <button class="ml-2 underline" @click="contacts.reload(query)">Try again</button>
        </div>
        <p v-else-if="!contacts.data.value.contacts.length" class="text-sm text-muted-foreground">No contacts found.</p>
        <ul v-else class="divide-y divide-border">
          <li v-for="c in contacts.data.value.contacts" :key="c.id" class="flex items-center gap-3 py-2">
            <span class="grid size-9 place-items-center rounded-full bg-muted text-xs font-medium">{{ genesis.initials(c.name) }}</span>
            <div class="min-w-0"><p class="truncate text-sm font-medium">{{ c.name }}</p><p class="truncate text-xs text-muted-foreground">{{ c.email || c.phone }}</p></div>
          </li>
        </ul>
      </div>
    </section>
    <section class="rounded-xl border border-border bg-card shadow-sm">
      <header class="border-b p-4"><h2 class="font-semibold">Upcoming appointments</h2></header>
      <div class="p-4">
        <div v-if="events.loading.value" class="space-y-2"><div v-for="i in 3" :key="i" class="h-10 animate-pulse rounded-md bg-muted"></div></div>
        <div v-else-if="events.error.value" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {{ genesis.errorText(events.error.value) }}
          <button class="ml-2 underline" @click="events.reload()">Try again</button>
        </div>
        <p v-else-if="!events.data.value.events.length" class="text-sm text-muted-foreground">No upcoming appointments.</p>
        <ul v-else class="divide-y divide-border">
          <li v-for="e in events.data.value.events" :key="e.id" class="flex items-center justify-between py-2 text-sm">
            <span class="font-medium">{{ e.title }}</span><span class="text-muted-foreground">{{ genesis.formatDateTime(e.startTime) }}</span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</main>\`;

const app = createApp({
  setup() {
    const query = ref("");
    const contacts = genesis.useHl((q) => hl.contacts.list({ query: q, limit: 20 }));
    const events = genesis.useHl(() => hl.calendars.events({ limit: 10 }));
    let timer;
    watch(query, (q) => { clearTimeout(timer); timer = setTimeout(() => contacts.reload(q), 300); });
    return { query, contacts, events, genesis };
  },
  template: TEMPLATE,
});
app.use(genesis);
app.mount("#app");
</file>
<file path="styles.css">
.error button { cursor: pointer; }
</file>
Next, you could add a contact detail drawer or a "create contact" form.`;

const RENAME_EDIT = `Renaming the contacts heading.
<edit path="app.js">
<search>
        <h2 class="font-semibold">Contacts</h2>
</search>
<replace>
        <h2 class="font-semibold">People</h2>
</replace>
</edit>`;

const MISMATCH_EDIT = `Updating the title.
<edit path="app.js">
<search>
this line does not exist
</search>
<replace>
x
</replace>
</edit>`;

export async function mockCompletion(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  onChunk: (chunk: LlmChunk) => void,
): Promise<LlmResult> {
  const last = messages[messages.length - 1];
  const text = (message: Anthropic.MessageParam) => (typeof message.content === "string" ? message.content : "");
  const request = text(last).includes("<request>") ? text(last).slice(text(last).lastIndexOf("<request>")) : "";
  // The route's follow-up after a failed edit: re-send whole files (unless the test asks it not to).
  const isRepair = text(last).includes("could not be applied");
  const shouldFail = /\bfail\b/i.test(request);
  const output = isRepair
    ? messages.some((message) => /\bnorepair\b/.test(text(message)))
      ? "Sorry, I can't."
      : APP
    : /\brename\b/i.test(request)
      ? RENAME_EDIT
      : /\bmismatch\b/i.test(request)
        ? MISMATCH_EDIT
        : APP;
  const cutoff = shouldFail ? Math.floor(output.length * 0.6) : output.length;
  for (let i = 0; i < cutoff; i += 40) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    onChunk({ type: "text", text: output.slice(i, Math.min(i + 40, cutoff)) });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (shouldFail) throw new Error("Simulated connection drop");
  return { stopReason: "end_turn", usage: null };
}
