<script setup lang="ts">
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'
import { monaco } from '@/lib/monaco'
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { FileCodeIcon, FileIcon, Loader2Icon, LockIcon, SaveIcon, Undo2Icon, XIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { db } from '@/lib/firebase'
import { cn } from '@/lib/utils'
import type { ProjectFile } from '@/types'

const props = defineProps<{
  projectId: string
  files: ProjectFile[]
  streamingFiles: Map<string, string>
  activeStreamPath: string | null
  completedPaths: Set<string>
  streaming: boolean
  locked: boolean
}>()
const emit = defineEmits<{ 'update:dirtyCount': [count: number] }>()

const openTabs = ref<string[]>([])
const selected = ref<string | null>(null)
/** Unsaved manual edits, keyed by path. */
const drafts = reactive(new Map<string, string>())
const saving = ref(false)

const saved = computed(() => new Map(props.files.map((f) => [f.path, f])))
const allPaths = computed(() => {
  const paths = new Set(props.files.map((f) => f.path))
  for (const p of props.streamingFiles.keys()) paths.add(p)
  return [...paths].sort((a, b) => a.localeCompare(b))
})
const isDirty = (path: string) => drafts.has(path) && drafts.get(path) !== saved.value.get(path)?.content
const dirtyPaths = computed(() => [...drafts.keys()].filter(isDirty))
watch(dirtyPaths, (d) => emit('update:dirtyCount', d.length), { immediate: true })

/** While streaming, the editor shows the live buffer; otherwise the draft or saved content. */
const content = computed(() => {
  const path = selected.value
  if (!path) return ''
  if (props.streaming && props.streamingFiles.has(path)) return props.streamingFiles.get(path) ?? ''
  return drafts.get(path) ?? saved.value.get(path)?.content ?? ''
})
const readOnly = computed(() => props.streaming || props.locked)

function open(path: string) {
  if (!openTabs.value.includes(path)) openTabs.value.push(path)
  selected.value = path
}
function close(path: string) {
  openTabs.value = openTabs.value.filter((p) => p !== path)
  if (selected.value === path) selected.value = openTabs.value.at(-1) ?? null
}

// Follow the file the AI is currently writing.
watch(
  () => props.activeStreamPath,
  (p) => p && open(p),
)
// Open index.html (or the first file) when a project loads; drop tabs for deleted files.
watch(
  allPaths,
  (paths) => {
    openTabs.value = openTabs.value.filter((p) => paths.includes(p))
    if (selected.value && !paths.includes(selected.value)) selected.value = openTabs.value.at(-1) ?? null
    if (!selected.value && paths.length) open(paths.includes('index.html') ? 'index.html' : paths[0])
  },
  { immediate: true },
)

function onChange(value: string | undefined) {
  if (readOnly.value || !selected.value || value === undefined) return
  // Typing back to the saved text (e.g. via undo) is not an edit; a leftover draft would mask the next AI change.
  if (value === saved.value.get(selected.value)?.content) drafts.delete(selected.value)
  else drafts.set(selected.value, value)
}

// Monaco models are global, keyed by URI: prefix with the project id so projects never share one.
const modelPath = computed(() => selected.value && `${props.projectId}/${selected.value}`)
type MonacoEditor = { getValue(): string; setValue(v: string): void }
const editor = shallowRef<MonacoEditor | null>(null)
const onMount = (e: MonacoEditor) => (editor.value = e)
// The wrapper reuses an existing model on tab switch, so content changed while hidden must be pushed in.
watch([modelPath, content], async () => {
  await nextTick()
  if (editor.value && editor.value.getValue() !== content.value) editor.value.setValue(content.value)
})
onBeforeUnmount(() => {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.path.replace(/^\//, '').startsWith(`${props.projectId}/`)) model.dispose()
  }
})

async function save(path = selected.value) {
  if (!path || !isDirty(path)) return
  const file = saved.value.get(path)
  if (!file) return
  saving.value = true
  try {
    await updateDoc(doc(db, 'projects', props.projectId, 'files', file.id), {
      content: drafts.get(path),
      updatedBy: 'user',
      updatedAt: serverTimestamp(),
    })
    drafts.delete(path)
    toast.success(`Saved ${path}`)
  } catch (err) {
    const msg = (err as Error).message
    toast.error(msg.includes('permission') ? 'Cannot save while a generation is running.' : `Save failed: ${msg}`)
  } finally {
    saving.value = false
  }
}
function discard(path = selected.value) {
  if (path) drafts.delete(path)
}

function language(path: string | null) {
  const ext = path?.split('.').pop()
  return (
    ({ js: 'javascript', html: 'html', css: 'css', json: 'json', md: 'markdown', svg: 'xml' } as Record<string, string>)[ext ?? ''] ??
    'plaintext'
  )
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    void save()
  }
}

const editorOptions = computed(() => ({
  readOnly: readOnly.value,
  minimap: { enabled: false },
  fontSize: 13,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  wordWrap: 'on' as const,
  tabSize: 2,
}))
</script>

<template>
  <div class="flex h-full min-w-0" @keydown="onKeydown">
    <div class="w-44 shrink-0 border-r bg-muted/30">
      <div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</div>
      <ScrollArea class="h-[calc(100%-2rem)]">
        <p v-if="!allPaths.length" class="px-3 text-xs text-muted-foreground">No files yet.</p>
        <button
          v-for="p in allPaths"
          :key="p"
          :class="
            cn(
              'flex w-full items-center gap-1.5 truncate px-3 py-1 text-left font-mono text-xs hover:bg-muted',
              selected === p && 'bg-muted font-medium',
            )
          "
          :style="{ paddingLeft: `${12 + (p.split('/').length - 1) * 10}px` }"
          :title="p"
          @click="open(p)"
        >
          <Loader2Icon v-if="streaming && streamingFiles.has(p) && !completedPaths.has(p)" class="size-3 shrink-0 animate-spin" />
          <FileCodeIcon v-else class="size-3 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ p.split('/').pop() }}</span>
          <span v-if="isDirty(p)" class="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" aria-label="unsaved" />
        </button>
      </ScrollArea>
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-9 items-center border-b">
        <div class="flex min-w-0 flex-1 overflow-x-auto">
          <div
            v-for="p in openTabs"
            :key="p"
            :class="
              cn(
                'group flex shrink-0 cursor-pointer items-center gap-1 border-r px-3 font-mono text-xs',
                selected === p ? 'bg-background' : 'bg-muted/40 text-muted-foreground',
              )
            "
            @click="selected = p"
          >
            {{ p }}<span v-if="isDirty(p)" class="text-amber-600">•</span>
            <button class="rounded p-0.5 opacity-50 hover:bg-muted hover:opacity-100" aria-label="Close tab" @click.stop="close(p)">
              <XIcon class="size-3" />
            </button>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1 px-2">
          <span v-if="readOnly" class="flex items-center gap-1 text-xs text-muted-foreground">
            <LockIcon class="size-3" /> {{ streaming ? 'Streaming' : 'Locked' }}
          </span>
          <template v-else-if="selected && isDirty(selected)">
            <Button size="xs" variant="ghost" @click="discard()"><Undo2Icon /> Discard</Button>
            <Button size="xs" :disabled="saving" @click="save()">
              <Loader2Icon v-if="saving" class="animate-spin" /><SaveIcon v-else /> Save
            </Button>
          </template>
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <VueMonacoEditor
          v-if="selected"
          :path="modelPath!"
          :value="content"
          :language="language(selected)"
          :options="editorOptions"
          theme="vs"
          @change="onChange"
          @mount="onMount"
        >
          <div class="grid h-full place-items-center text-xs text-muted-foreground">Loading editor...</div>
        </VueMonacoEditor>
        <div v-else class="grid h-full place-items-center text-sm text-muted-foreground">
          <div class="flex flex-col items-center gap-2"><FileIcon class="size-8" /> Generated files will appear here.</div>
        </div>
      </div>
    </div>
  </div>
</template>
