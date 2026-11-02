<script setup lang="ts">
import { toast } from 'vue-sonner'
import { ArrowLeftIcon, CheckCircle2Icon, Loader2Icon, PlugIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import ChatPanel from '@/components/workspace/ChatPanel.vue'
import EditorPanel from '@/components/workspace/EditorPanel.vue'
import PreviewPanel from '@/components/workspace/PreviewPanel.vue'
import SnapshotSheet from '@/components/workspace/SnapshotSheet.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useGeneration } from '@/composables/useGeneration'
import { useHlStatus } from '@/composables/useHlStatus'
import { useWorkspace } from '@/composables/useWorkspace'

const props = defineProps<{ id: string }>()
const router = useRouter()

const { project, files, fileMap, messages, snapshots, loaded, error } = useWorkspace(props.id)
const gen = useGeneration(props.id, project)
const { hl, connected } = useHlStatus()
const dirtyCount = ref(0)

const streamingPaths = computed(() => [...new Set([...gen.streamingFiles.value.keys(), ...gen.editingPaths.value])])
const streaming = computed(() => gen.phase.value === 'streaming')

// A generation would overwrite unsaved manual edits.
const sendBlockedReason = computed(() =>
  dirtyCount.value ? `Save or discard ${dirtyCount.value} unsaved edit${dirtyCount.value > 1 ? 's' : ''} before generating.` : null,
)
function fixWithAi(prompt: string) {
  if (sendBlockedReason.value) toast.warning(sendBlockedReason.value)
  else void gen.start(prompt)
}
const restoreBlockedReason = computed(() => {
  if (gen.busy.value) return 'Wait for the current generation to finish.'
  if (dirtyCount.value) return 'Save or discard your unsaved edits first.'
  return null
})
</script>

<template>
  <div class="flex h-screen flex-col">
    <header class="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div class="flex min-w-0 items-center gap-2">
        <Button size="icon-sm" variant="ghost" aria-label="Back to dashboard" @click="router.push('/dashboard')">
          <ArrowLeftIcon />
        </Button>
        <span class="truncate font-medium">{{ project?.name ?? 'Loading...' }}</span>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="connected" variant="secondary" class="hidden gap-1 sm:flex">
          <CheckCircle2Icon class="size-3 text-green-600" /> {{ hl.locationName || 'HighLevel connected' }}
        </Badge>
        <Button v-else size="sm" variant="outline" @click="router.push('/dashboard')"><PlugIcon /> Connect HighLevel</Button>
        <SnapshotSheet :project-id="id" :snapshots="snapshots" :blocked-reason="restoreBlockedReason" />
      </div>
    </header>

    <div v-if="!loaded" class="grid flex-1 place-items-center"><Loader2Icon class="animate-spin text-muted-foreground" /></div>
    <div v-else-if="error || !project" class="grid flex-1 place-items-center text-center">
      <div class="space-y-3">
        <p class="text-sm text-muted-foreground">{{ error ?? 'Project not found.' }}</p>
        <Button variant="outline" @click="router.push('/dashboard')">Back to dashboard</Button>
      </div>
    </div>

    <ResizablePanelGroup v-else direction="horizontal" class="min-h-0 flex-1">
      <ResizablePanel :default-size="24" :min-size="18">
        <ChatPanel
          :messages="messages"
          :phase="gen.phase.value"
          :busy="gen.busy.value"
          :cancelling="gen.cancelling.value"
          :draft-text="gen.draftText.value"
          :streaming-paths="streamingPaths"
          :editing-paths="gen.editingPaths.value"
          :completed-paths="gen.completedPaths.value"
          :hl-connected="connected"
          :blocked-reason="sendBlockedReason"
          @send="gen.start"
          @cancel="gen.cancel"
        />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel :default-size="40" :min-size="25">
        <EditorPanel
          v-model:dirty-count="dirtyCount"
          :project-id="id"
          :files="files"
          :streaming-files="gen.streamingFiles.value"
          :active-stream-path="gen.activePath.value"
          :completed-paths="gen.completedPaths.value"
          :streaming="streaming"
          :locked="gen.busy.value"
        />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel :default-size="36" :min-size="20">
        <PreviewPanel :file-map="fileMap" :generating="gen.busy.value" :hl-connected="connected" @fix="fixWithAi" />
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
</template>
