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
  /** Live project files, to tell whether a snapshot is what's on screen right now. */
  fileMap: Map<string, string>
  /** Why restoring is unavailable right now (generation running, unsaved edits). */
  blockedReason: string | null
}>()

const pendingRestore = ref<Snapshot | null>(null)
const CHANGE_SYMBOL: Record<Change['kind'], string> = { added: '+', modified: '~', deleted: '−' }

// "Current" means identical to the live files, not just newest: after a saved hand edit the newest
// snapshot differs and must stay restorable.
const matchesLiveFiles = (snapshot: Snapshot) =>
  snapshot.files.length === props.fileMap.size && snapshot.files.every((file) => props.fileMap.get(file.path) === file.content)
// After a restore, two snapshots match the live files; only the newest is labelled Current.
const currentSnapshotId = computed(() => props.snapshots.find(matchesLiveFiles)?.id ?? null)
const isCurrent = (snapshot: Snapshot) => snapshot.id === currentSnapshotId.value
const restoring = ref(false)
const diff = ref<{ path: string; before: string; after: string; label: string } | null>(null)

type Change = { path: string; kind: 'added' | 'modified' | 'deleted' }
/** What each snapshot changed relative to the one before it (snapshots are newest-first). */
const changes = computed(() => {
  const result = new Map<string, Change[]>()
  props.snapshots.forEach((snapshot, i) => {
    const prev = new Map((props.snapshots[i + 1]?.files ?? []).map((file) => [file.path, file.content]))
    const curr = new Map(snapshot.files.map((file) => [file.path, file.content]))
    const list: Change[] = []
    for (const [path, content] of curr) {
      if (!prev.has(path)) list.push({ path, kind: 'added' })
      else if (prev.get(path) !== content) list.push({ path, kind: 'modified' })
    }
    for (const path of prev.keys()) if (!curr.has(path)) list.push({ path, kind: 'deleted' })
    result.set(snapshot.id, list)
  })
  return result
})

function openDiff(snapshot: Snapshot, change: Change) {
  const index = props.snapshots.indexOf(snapshot)
  const before = props.snapshots[index + 1]?.files.find((file) => file.path === change.path)?.content ?? ''
  const after = snapshot.files.find((file) => file.path === change.path)?.content ?? ''
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

const formatTime = (snapshot: Snapshot) => snapshot.createdAt?.toDate().toLocaleString() ?? 'Just now'
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
        <div v-for="(snapshot, index) in snapshots" :key="snapshot.id" class="space-y-2 border-b py-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-sm font-medium">
                {{ snapshot.label }}
                <Badge v-if="isCurrent(snapshot)" variant="secondary">Current</Badge>
                <Badge v-else-if="index === 0" variant="outline">Edited since</Badge>
                <Badge v-if="snapshot.status === 'partial'" variant="destructive">Partial</Badge>
              </div>
              <p class="text-xs text-muted-foreground">{{ formatTime(snapshot) }} · {{ snapshot.files.length }} files</p>
              <p v-if="snapshot.prompt" class="mt-1 line-clamp-2 text-xs italic text-muted-foreground">"{{ snapshot.prompt }}"</p>
            </div>
            <Button
              v-if="!matchesLiveFiles(snapshot)"
              size="xs"
              variant="outline"
              :disabled="!!blockedReason"
              :title="blockedReason ?? undefined"
              @click="pendingRestore = snapshot"
            >
              <RotateCcwIcon /> Restore
            </Button>
          </div>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="change in changes.get(snapshot.id) ?? []"
              :key="change.path"
              class="rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
              :class="{
                'text-green-700': change.kind === 'added',
                'text-amber-700': change.kind === 'modified',
                'text-destructive line-through': change.kind === 'deleted',
              }"
              :title="`View ${change.kind} file`"
              @click="openDiff(snapshot, change)"
            >
              {{ CHANGE_SYMBOL[change.kind] }} {{ change.path }}
            </button>
          </div>
        </div>
      </ScrollArea>
    </SheetContent>
  </Sheet>

  <Dialog :open="!!pendingRestore" @update:open="(open: boolean) => !open && (pendingRestore = null)">
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

  <Dialog :open="!!diff" @update:open="(open: boolean) => !open && (diff = null)">
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
