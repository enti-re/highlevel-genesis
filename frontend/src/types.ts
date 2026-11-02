import type { Timestamp } from 'firebase/firestore'

export interface HlStatus {
  status?: 'connected' | 'disconnected' | 'expired'
  locationId?: string | null
  locationName?: string | null
}

export interface Project {
  id: string
  ownerId: string
  name: string
  description?: string
  locationId?: string | null
  deleted: boolean
  activeGeneration?: { id: string; startedAt: number } | null
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export interface ProjectFile {
  id: string
  path: string
  content: string
  updatedBy?: 'ai' | 'user' | 'restore'
}

export type GenerationStatus = 'complete' | 'partial' | 'failed' | 'no_changes' | 'cancelled' | 'cancelled_partial'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status?: GenerationStatus
  files?: string[]
  deletedFiles?: string[]
  warnings?: string[]
  error?: { code: string; message: string; retryable: boolean } | null
  snapshotId?: string | null
  /** Server-side check of how likely this version is to work (functions/src/generation/confidence.ts). */
  confidence?: { score: number; level: 'high' | 'medium' | 'low'; reasons: string[] } | null
  createdAt?: Timestamp
}

export interface Snapshot {
  id: string
  label: string
  prompt?: string | null
  status: 'complete' | 'partial'
  restoredFrom?: string
  files: { path: string; content: string }[]
  createdAt?: Timestamp
}
