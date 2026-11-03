import { collection, doc, limit, limitToLast, onSnapshot, orderBy, query } from 'firebase/firestore'
import { computed, onScopeDispose, ref } from 'vue'
import { db } from '@/lib/firebase'
import type { ChatMessage, Project, ProjectFile, Snapshot } from '@/types'

/** Newest chat messages and versions loaded per project. */
const MAX_MESSAGES = 200
const MAX_SNAPSHOTS = 50

/** Firestore listeners are the source of truth; SSE only drives the in-flight view, so a dropped stream recovers. */
export function useWorkspace(projectId: string) {
  const project = ref<Project | null>(null)
  const files = ref<ProjectFile[]>([])
  const messages = ref<ChatMessage[]>([])
  const snapshots = ref<Snapshot[]>([])
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const projectRef = doc(db, 'projects', projectId)
  const onError = (firestoreError: Error) => {
    error.value = firestoreError.message.includes('permission') ? 'Project not found or you do not have access.' : firestoreError.message
    loaded.value = true
  }

  const unsubs = [
    onSnapshot(
      projectRef,
      (snap) => {
        const data = snap.data()
        project.value = data && !data.deleted ? ({ id: snap.id, ...data } as Project) : null
        if (!project.value) error.value = 'Project not found.'
        loaded.value = true
      },
      onError,
    ),
    onSnapshot(
      collection(projectRef, 'files'),
      (snap) => {
        files.value = snap.docs
          .map((fileDoc) => ({ id: fileDoc.id, ...(fileDoc.data() as Omit<ProjectFile, 'id'>) }))
          .sort((a, b) => a.path.localeCompare(b.path))
      },
      onError,
    ),
    onSnapshot(
      query(collection(projectRef, 'messages'), orderBy('createdAt', 'asc'), limitToLast(MAX_MESSAGES)),
      (snap) => {
        messages.value = snap.docs.map((messageDoc) => ({ id: messageDoc.id, ...(messageDoc.data() as Omit<ChatMessage, 'id'>) }))
      },
      onError,
    ),
    onSnapshot(
      query(collection(projectRef, 'snapshots'), orderBy('createdAt', 'desc'), limit(MAX_SNAPSHOTS)),
      (snap) => {
        snapshots.value = snap.docs.map((snapshotDoc) => ({ id: snapshotDoc.id, ...(snapshotDoc.data() as Omit<Snapshot, 'id'>) }))
      },
      onError,
    ),
  ]
  onScopeDispose(() => unsubs.forEach((unsubscribe) => unsubscribe()))

  const fileMap = computed(() => new Map(files.value.map((file) => [file.path, file.content])))
  return { project, files, fileMap, messages, snapshots, loaded, error }
}
