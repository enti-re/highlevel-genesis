import type { Project } from '@/types'

/** Must match STALE_LOCK_MS in functions/src/lib/store.ts and the 600000 in firestore.rules. */
export const STALE_LOCK_MS = 10 * 60 * 1000

/** A lock older than STALE_LOCK_MS is from a dead instance; server and rules ignore it, so the UI must too. */
export function isGenerating(project: Pick<Project, 'activeGeneration'> | null | undefined, now = Date.now()): boolean {
  const active = project?.activeGeneration
  return !!active && now - active.startedAt < STALE_LOCK_MS
}
