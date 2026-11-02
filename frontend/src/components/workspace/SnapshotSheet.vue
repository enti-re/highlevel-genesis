<script setup lang="ts">
import { VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import '@/lib/monaco'
import { HistoryIcon, Loader2Icon, RotateCcwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { apiFetch, errorMessage } from '@/lib/api'
import type { Snapshot } from '@/types'

const props = defineProps<{
  projectId: string
  snapshots: Snapshot[]
  /** Why restoring is unavailable right now (generation running, unsaved edits). */
  blockedReason: string | null
}>()

const pendingRestore = ref<Snapshot | null>(null)
const restoring = ref(false)
const diff = ref<{ path: string; before: string; after: string; label: string } | null>(null)

type Change = { path: string; kind: 'added' | 'modified' | 'deleted' }
/** What each snapshot changed relative to the one before it (snapshots are newest-first). */
const changes = computed(() => {
  const result = new Map<string, Change[]>()
  props.snapshots.forEach((s, i) => {
    const prev = new Map((props.snapshots[i + 1]?.files ?? []).map((f) => [f.path, f.content]))
    const curr = new Map(s.files.map((f) => [f.path, f.content]))
    const list: Change[] = []
    for (const [path, content] of curr) {
      if (!prev.has(path)) list.push({ path, kind: 'added' })
      else if (prev.get(path) !== content) list.push({ path, kind: 'modified' })
    }
    for (const path of prev.keys()) if (!curr.has(path)) list.push({ path, kind: 'deleted' })
    result.set(s.id, list)
  })
  return result
})

function openDiff(snapshot: Snapshot, change: Change) {
  const i = props.snapshots.indexOf(snapshot)
  const before = props.snapshots[i + 1]?.files.find((f) => f.path === change.path)?.content ?? ''
  const after = snapshot.files.find((f) => f.path === change.path)?.content ?? ''
  diff.value = { path: change.path, before, after, label: formatTime(snapshot) }
}

async function restore() {
  if (!pendingRestore.value) return
  restoring.value = true
  try {
    await apiFetch(`/projects/${props.projectId}/snapshots/${pendingRestore.value.id}/restore`, { method: 'POST' })
    toast.success('Version restored')
    pendingRestore.value = null
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    restoring.value = false
  }
}

const formatTime = (s: Snapshot) => s.createdAt?.toDate().toLocaleString() ?? 'Just now'
const language = (path: string) =>
  (({ js: 'javascript', html: 'html', css: 'css', json: 'json' }) as Record<string, string>)[path.split('.').pop() ?? ''] ?? 'plaintext'
</script>

<template>
  <Sheet>
    <SheetTrigger as-child>
      <Button size="sm" variant="outline">
        <HistoryIcon /> History
        <Badge v-if="snapshots.length" variant="secondary" class="h-4 px-1 text-[10px]">{{ snapshots.length }}</Badge>
      </Button>
    </SheetTrigger>
    <SheetContent class="w-full sm:max-w-md">
      <SheetHeader>
        <SheetTitle>Version history</SheetTitle>
        <SheetDescription>Every generation saves a snapshot. Restoring also creates one, so it can be undone.</SheetDescription>
      </SheetHeader>
      <ScrollArea class="h-[calc(100vh-8rem)] px-4">
        <p v-if="!snapshots.length" class="text-sm text-muted-foreground">No versions yet. Generate something first.</p>
        <div v-for="(s, i) in snapshots" :key="s.id" class="space-y-2 border-b py-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-sm font-medium">
                {{ s.label }}
                <Badge v-if="i === 0" variant="secondary">Current</Badge>
                <Badge v-if="s.status === 'partial'" variant="destructive">Partial</Badge>
              </div>
              <p class="text-xs text-muted-foreground">{{ formatTime(s) }} · {{ s.files.length }} files</p>
              <p v-if="s.prompt" class="mt-1 line-clamp-2 text-xs italic text-muted-foreground">"{{ s.prompt }}"</p>
            </div>
            <Button
              v-if="i !== 0"
              size="xs"
              variant="outline"
              :disabled="!!blockedReason"
              :title="blockedReason ?? undefined"
              @click="pendingRestore = s"
            >
              <RotateCcwIcon /> Restore
            </Button>
          </div>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="c in changes.get(s.id) ?? []"
              :key="c.path"
              class="rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
              :class="{
                'text-green-700': c.kind === 'added',
                'text-amber-700': c.kind === 'modified',
                'text-destructive line-through': c.kind === 'deleted',
              }"
              :title="`View ${c.kind} file`"
              @click="openDiff(s, c)"
            >
              {{ c.kind === 'added' ? '+' : c.kind === 'deleted' ? '−' : '~' }} {{ c.path }}
            </button>
          </div>
        </div>
      </ScrollArea>
    </SheetContent>
  </Sheet>

  <Dialog :open="!!pendingRestore" @update:open="(o: boolean) => !o && (pendingRestore = null)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Restore this version?</DialogTitle>
        <DialogDescription>
          Project files will be replaced with the version from {{ pendingRestore && formatTime(pendingRestore) }}. The current version stays
          in history.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="pendingRestore = null">Cancel</Button>
        <Button :disabled="restoring" @click="restore"> <Loader2Icon v-if="restoring" class="animate-spin" /> Restore </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="!!diff" @update:open="(o: boolean) => !o && (diff = null)">
    <DialogContent class="max-w-5xl sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle class="font-mono text-sm">{{ diff?.path }}</DialogTitle>
        <DialogDescription>Changes made in the version from {{ diff?.label }}.</DialogDescription>
      </DialogHeader>
      <div class="h-[60vh] overflow-hidden rounded border">
        <VueMonacoDiffEditor
          v-if="diff"
          :original="diff.before"
          :modified="diff.after"
          :language="language(diff.path)"
          :options="{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true }"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
