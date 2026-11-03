import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { toast } from 'vue-sonner'
import { ApiError, apiFetch, errorMessage } from '@/lib/api'
import { isGenerating } from '@/lib/lock'
import { postSse } from '@/lib/sse'
import type { Project } from '@/types'

type Phase = 'idle' | 'streaming' | 'recovering'

/**
 *  idle --send--> streaming --done/error--> idle
 *                     +--connection lost--> recovering --lock cleared in Firestore--> idle
 * The server keeps generating after a disconnect, so "recovering" just waits for its save.
 */
export function useGeneration(projectId: string, project: Ref<Project | null>) {
  const phase = ref<Phase>('idle')
  const generationId = ref<string | null>(null)
  const draftText = ref('')
  const streamingFiles = shallowRef(new Map<string, string>())
  const activePath = ref<string | null>(null)
  /** Files being patched with search/replace edits (no content is streamed for these). */
  const editingPaths = ref(new Set<string>())
  const completedPaths = ref(new Set<string>())
  const warnings = ref<string[]>([])
  const cancelling = ref(false)

  // Ticks so a lock left behind by a dead server instance expires in the UI too.
  const now = ref(Date.now())
  const clock = setInterval(() => (now.value = Date.now()), 30_000)
  onScopeDispose(() => clearInterval(clock))

  /** True whenever the server holds the lock, including generations started in another tab. */
  const serverBusy = computed(() => isGenerating(project.value, now.value))
  const busy = computed(() => phase.value !== 'idle' || serverBusy.value)

  function resetBuffers() {
    draftText.value = ''
    streamingFiles.value = new Map()
    activePath.value = null
    editingPaths.value = new Set()
    completedPaths.value = new Set()
    warnings.value = []
  }

  function appendToFile(path: string, delta: string) {
    const next = new Map(streamingFiles.value)
    next.set(path, (next.get(path) ?? '') + delta)
    streamingFiles.value = next
  }

  async function start(prompt: string): Promise<boolean> {
    if (busy.value) return false
    resetBuffers()
    phase.value = 'streaming'
    cancelling.value = false
    generationId.value = null
    let finished = false

    try {
      await postSse('/generate', { projectId, prompt }, ({ event, data }) => {
        switch (event) {
          case 'start':
            generationId.value = data.generationId
            break
          case 'reset':
            resetBuffers()
            break
          case 'text':
            draftText.value += data.delta
            break
          case 'file_start':
            activePath.value = data.path
            appendToFile(data.path, '')
            break
          case 'token':
            appendToFile(data.path, data.delta)
            break
          case 'file_end':
          case 'edit_end':
            completedPaths.value = new Set(completedPaths.value).add(data.path)
            break
          case 'edit_start':
            editingPaths.value = new Set(editingPaths.value).add(data.path)
            break
          case 'warning':
            warnings.value.push(data.message)
            break
          case 'done': {
            finished = true
            const changed = (data.files?.length ?? 0) + (data.deleted?.length ?? 0)
            if (data.status === 'no_changes') toast.info('No files changed.')
            else toast.success(`Generated ${changed} file${changed === 1 ? '' : 's'}`)
            for (const w of data.warnings ?? []) toast.warning(w)
            break
          }
          case 'error': {
            finished = true
            const saved = data.savedFiles?.length ?? 0
            const description = saved ? `${saved} completed file${saved === 1 ? ' was' : 's were'} saved as a partial version.` : undefined
            if (data.code === 'CANCELLED') toast.info(data.message, { description })
            else toast.error(data.message, { description })
            break
          }
        }
      })
      if (!finished) throw new ApiError(0, 'STREAM_INTERRUPTED', 'Connection lost during generation.', true)
      phase.value = 'idle'
    } catch (err) {
      const interrupted = err instanceof ApiError && (err.code === 'STREAM_INTERRUPTED' || err.code === 'NETWORK')
      if (interrupted && generationId.value) {
        // The server is still working and will save the result; wait for the lock to clear.
        phase.value = 'recovering'
        // The unlock may have reached us before the stream error did; then there is nothing to wait for.
        if (!serverBusy.value) {
          phase.value = 'idle'
          toast.info('Generation finished', { description: 'See the chat for the result.' })
        } else toast.warning('Connection lost', { description: 'The server is still finishing. Your files will appear when saved.' })
      } else {
        phase.value = 'idle'
        toast.error(errorMessage(err))
      }
    } finally {
      if (phase.value === 'idle') resetBuffers()
    }
    return finished
  }

  // Leave "recovering" once Firestore shows the project unlocked (or the lock goes stale).
  watch(serverBusy, (active) => {
    if (active) return
    cancelling.value = false
    if (phase.value === 'recovering') {
      phase.value = 'idle'
      resetBuffers()
      toast.info('Generation finished', { description: 'See the chat for the result.' })
    }
  })

  async function cancel() {
    const id = generationId.value ?? project.value?.activeGeneration?.id
    if (!id || cancelling.value) return
    cancelling.value = true
    try {
      await apiFetch('/generate/cancel', { method: 'POST', body: { projectId, generationId: id } })
    } catch (err) {
      cancelling.value = false
      toast.error(errorMessage(err))
    }
  }

  return {
    phase,
    busy,
    serverBusy,
    cancelling,
    draftText,
    streamingFiles,
    activePath,
    editingPaths,
    completedPaths,
    warnings,
    start,
    cancel,
  }
}
