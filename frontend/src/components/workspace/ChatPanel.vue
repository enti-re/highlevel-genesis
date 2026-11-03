<script setup lang="ts">
import { ArrowUpIcon, FileCodeIcon, Loader2Icon, PencilIcon, RotateCcwIcon, SquareIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import type { ChatMessage } from '@/types'

const props = defineProps<{
  messages: ChatMessage[]
  phase: 'idle' | 'streaming' | 'recovering'
  busy: boolean
  cancelling: boolean
  draftText: string
  streamingPaths: string[]
  editingPaths: Set<string>
  completedPaths: Set<string>
  hlConnected: boolean
  blockedReason: string | null
}>()
const emit = defineEmits<{ send: [prompt: string]; cancel: [] }>()

const input = ref('')
const viewport = ref<HTMLElement | null>(null)

const EXAMPLES = [
  'Build a contact dashboard with search and a list of upcoming appointments',
  'Show my latest conversations with unread counts, and let me open one to read its messages',
  'A form to add a new contact with name, email, phone and tags',
]

const STATUS_LABEL: Record<string, { text: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
  complete: { text: 'Saved', variant: 'secondary' },
  partial: { text: 'Partially saved', variant: 'destructive' },
  failed: { text: 'Failed', variant: 'destructive' },
  cancelled: { text: 'Cancelled', variant: 'outline' },
  cancelled_partial: { text: 'Cancelled, partial save', variant: 'outline' },
  no_changes: { text: 'No changes', variant: 'outline' },
}

const canSend = computed(() => !!input.value.trim() && !props.busy && !props.blockedReason)

function send(text = input.value) {
  const prompt = text.trim()
  if (!prompt || props.busy || props.blockedReason) return
  emit('send', prompt)
  input.value = ''
}

/** The user prompt that produced a given assistant message, used for "Retry". */
function promptBefore(index: number): string | null {
  for (let i = index - 1; i >= 0; i--) if (props.messages[i].role === 'user') return props.messages[i].content
  return null
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

watch(
  () => [props.messages.at(-1)?.id, props.draftText.length, props.streamingPaths.length],
  async () => {
    await nextTick()
    const el = viewport.value?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    el?.scrollTo({ top: el.scrollHeight })
  },
)
</script>

<template>
  <div class="flex h-full flex-col">
    <div ref="viewport" class="min-h-0 flex-1">
      <ScrollArea class="h-full">
        <div class="space-y-4 p-4">
          <div v-if="!messages.length && phase === 'idle'" class="space-y-3 pt-6 text-sm">
            <p class="font-medium">What should we build?</p>
            <p class="text-muted-foreground">
              Describe a HighLevel app. It will read live data from your
              {{ hlConnected ? 'connected location' : 'location once you connect HighLevel' }}.
            </p>
            <button
              v-for="example in EXAMPLES"
              :key="example"
              class="block w-full rounded-lg border bg-background p-3 text-left transition hover:bg-muted"
              @click="send(example)"
            >
              {{ example }}
            </button>
          </div>

          <template v-for="(message, index) in messages" :key="message.id">
            <div
              v-if="message.role === 'user'"
              class="ml-8 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap"
            >
              {{ message.content }}
            </div>
            <p v-else-if="message.role === 'system'" class="text-center text-xs text-muted-foreground">{{ message.content }}</p>
            <div v-else class="mr-4 space-y-2 text-sm">
              <p v-if="message.content" class="whitespace-pre-wrap">{{ message.content }}</p>
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge v-if="message.status && STATUS_LABEL[message.status]" :variant="STATUS_LABEL[message.status].variant">
                  {{ STATUS_LABEL[message.status].text }}
                </Badge>
                <Badge v-for="file in message.files ?? []" :key="file" variant="outline" class="gap-1 font-mono">
                  <FileCodeIcon class="size-3" />{{ file }}
                </Badge>
                <Badge v-for="file in message.deletedFiles ?? []" :key="`d-${file}`" variant="outline" class="font-mono line-through">{{
                  file
                }}</Badge>
                <!-- Only shown when something looks off; a clean generation stays quiet. -->
                <Badge
                  v-if="message.confidence && message.confidence.level !== 'high' && message.status !== 'failed'"
                  variant="outline"
                  class="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
                  :title="`Confidence ${message.confidence.score}/100`"
                >
                  <TriangleAlertIcon class="size-3" />{{ message.confidence.level === 'low' ? 'Likely broken' : 'Check preview' }}
                </Badge>
              </div>
              <ul
                v-if="message.confidence && message.confidence.level !== 'high' && message.status !== 'failed'"
                class="space-y-0.5 text-xs text-muted-foreground"
              >
                <li v-for="reason in message.confidence.reasons" :key="reason">• {{ reason }}</li>
              </ul>
              <Alert v-if="message.error" variant="destructive">
                <TriangleAlertIcon />
                <AlertDescription class="flex flex-col items-start gap-2">
                  {{ message.error.message }}
                  <Button
                    v-if="message.error.retryable && promptBefore(index)"
                    size="xs"
                    variant="outline"
                    :disabled="busy || !!blockedReason"
                    @click="send(promptBefore(index)!)"
                  >
                    <RotateCcwIcon /> Retry
                  </Button>
                </AlertDescription>
              </Alert>
              <ul v-if="message.warnings?.length" class="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                <li v-for="warning in message.warnings" :key="warning">⚠ {{ warning }}</li>
              </ul>
            </div>
          </template>

          <div v-if="phase !== 'idle'" class="mr-4 space-y-2 text-sm">
            <p v-if="draftText.trim()" class="whitespace-pre-wrap">{{ draftText.trim() }}</p>
            <div class="flex flex-wrap gap-1.5">
              <Badge v-for="path in streamingPaths" :key="path" variant="outline" class="gap-1 font-mono">
                <Loader2Icon v-if="!completedPaths.has(path)" class="size-3 animate-spin" />
                <PencilIcon v-else-if="editingPaths.has(path)" class="size-3" />
                <FileCodeIcon v-else class="size-3" />{{ path
                }}<span v-if="editingPaths.has(path)" class="text-muted-foreground">edit</span>
              </Badge>
            </div>
            <p class="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon class="size-3 animate-spin" />
              {{
                phase === 'recovering'
                  ? 'Connection lost. Waiting for the server to save...'
                  : draftText || streamingPaths.length
                    ? 'Writing code...'
                    : 'Thinking...'
              }}
            </p>
          </div>
          <p v-else-if="busy" class="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon class="size-3 animate-spin" /> A generation is running for this project...
          </p>
        </div>
      </ScrollArea>
    </div>

    <form class="space-y-2 border-t p-3" @submit.prevent="send()">
      <p v-if="blockedReason" class="text-xs text-amber-700 dark:text-amber-400">{{ blockedReason }}</p>
      <Textarea
        v-model="input"
        rows="3"
        maxlength="4000"
        class="resize-none"
        :placeholder="messages.length ? 'Ask for a change...' : 'Describe the app you want...'"
        :disabled="busy"
        @keydown="onKeydown"
      />
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
        <Button v-if="busy" type="button" size="sm" variant="outline" :disabled="cancelling" @click="emit('cancel')">
          <Loader2Icon v-if="cancelling" class="animate-spin" /><SquareIcon v-else /> Stop
        </Button>
        <Button v-else type="submit" size="sm" :disabled="!canSend"><ArrowUpIcon /> Send</Button>
      </div>
    </form>
  </div>
</template>
