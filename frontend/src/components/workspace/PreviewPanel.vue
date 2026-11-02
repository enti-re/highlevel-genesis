<script setup lang="ts">
import { ActivityIcon, Loader2Icon, PlugZapIcon, RotateCwIcon, TriangleAlertIcon, WandSparklesIcon } from '@lucide/vue'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useHlBridge } from '@/composables/useHlBridge'
import { buildPreviewHtml } from '@/preview/buildPreview'

const props = defineProps<{
  fileMap: Map<string, string>
  generating: boolean
  hlConnected: boolean
}>()
const emit = defineEmits<{ fix: [prompt: string] }>()

const iframe = ref<HTMLIFrameElement | null>(null)
const reloadKey = ref(0)
const { calls, runtimeErrors, clear } = useHlBridge(iframe)

// Closes the loop by hand: the user sends the runtime error back through the normal generation path.
function fixWithAi() {
  const errors = [...new Set(runtimeErrors.value)]
    .slice(-3)
    .map((e) => `- ${e}`)
    .join('\n')
  emit('fix', `The preview throws this runtime error:\n${errors}\nFind the cause and fix it, changing as little code as possible.`)
}

/** Saved files only: half-written streaming code would just throw syntax errors. */
const preview = computed(() => buildPreviewHtml(props.fileMap))
/** Remount per render so each app starts from a fresh /preview.html. */
const frameKey = computed(() => `${reloadKey.value}:${hash(preview.value.html)}`)
function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
watch(
  () => preview.value.html,
  () => clear(),
)
/** Not srcdoc: it would inherit this page's strict CSP. */
function onPreviewMessage(ev: MessageEvent) {
  const frame = iframe.value?.contentWindow
  if (!frame || ev.source !== frame || ev.data?.__genesis !== 'preview:ready') return
  // Opaque (sandboxed) origin: '*' is the only valid target; we post to that exact window.
  frame.postMessage({ __genesis: 'preview:render', html: preview.value.html }, '*')
}
window.addEventListener('message', onPreviewMessage)
onScopeDispose(() => window.removeEventListener('message', onPreviewMessage))

function reload() {
  clear()
  reloadKey.value++
}
const failedCalls = computed(() => calls.value.filter((c) => !c.ok).length)
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-9 items-center justify-between border-b px-3">
      <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</span>
      <div class="flex items-center gap-1">
        <span v-if="generating" class="mr-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2Icon class="size-3 animate-spin" /> Updates when generation finishes
        </span>
        <Sheet>
          <SheetTrigger as-child>
            <Button size="xs" variant="ghost">
              <ActivityIcon /> HL calls
              <Badge v-if="calls.length" :variant="failedCalls ? 'destructive' : 'secondary'" class="h-4 px-1 text-[10px]">
                {{ calls.length }}
              </Badge>
            </Button>
          </SheetTrigger>
          <SheetContent class="w-full sm:max-w-md">
            <SheetHeader>
              <SheetTitle>HighLevel API calls</SheetTitle>
              <SheetDescription>Requests the preview made through the secure proxy.</SheetDescription>
            </SheetHeader>
            <ScrollArea class="h-[calc(100vh-8rem)] px-4">
              <p v-if="!calls.length" class="text-sm text-muted-foreground">No calls yet.</p>
              <div v-for="c in calls" :key="c.id" class="flex items-center justify-between border-b py-2 font-mono text-xs">
                <span>{{ c.op }}</span>
                <span :class="c.ok ? 'text-green-600' : 'text-destructive'">{{ c.ok ? 'ok' : c.code }} · {{ c.ms }}ms</span>
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>
        <Button size="icon-xs" variant="ghost" aria-label="Reload preview" @click="reload"><RotateCwIcon /></Button>
      </div>
    </div>

    <div v-if="!hlConnected || runtimeErrors.length || preview.missing.length" class="space-y-2 border-b p-2">
      <Alert v-if="!hlConnected">
        <PlugZapIcon />
        <AlertTitle>HighLevel not connected</AlertTitle>
        <AlertDescription>Connect from the dashboard to see real data in the preview.</AlertDescription>
      </Alert>
      <Alert v-if="preview.missing.length" variant="destructive">
        <TriangleAlertIcon />
        <AlertDescription>Missing files referenced by index.html: {{ preview.missing.join(', ') }}</AlertDescription>
      </Alert>
      <Alert v-if="runtimeErrors.length" variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>The app threw an error</AlertTitle>
        <AlertDescription class="space-y-2">
          <p class="font-mono text-xs">{{ runtimeErrors.at(-1) }}</p>
          <Button size="xs" variant="outline" :disabled="generating" @click="fixWithAi"><WandSparklesIcon /> Fix with AI</Button>
        </AlertDescription>
      </Alert>
    </div>

    <!-- allow-scripts WITHOUT allow-same-origin: generated code runs in an opaque origin
         and cannot touch the parent page, its storage, or the user's session. -->
    <iframe
      ref="iframe"
      :key="frameKey"
      src="/preview.html"
      sandbox="allow-scripts allow-forms allow-modals"
      title="App preview"
      class="min-h-0 w-full flex-1 bg-white"
    />
  </div>
</template>
