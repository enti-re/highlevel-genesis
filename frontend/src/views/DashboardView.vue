<script setup lang="ts">
import { addDoc, collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { FolderCodeIcon, Loader2Icon, LogOutIcon, PlusIcon, SparklesIcon, Trash2Icon } from '@lucide/vue'
import { onMounted, onScopeDispose, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import HighLevelConnection from '@/components/dashboard/HighLevelConnection.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/composables/useAuth'
import { useHlStatus } from '@/composables/useHlStatus'
import { apiFetch, endSession, errorMessage } from '@/lib/api'
import { auth, db } from '@/lib/firebase'
import { isGenerating } from '@/lib/lock'
import type { Project } from '@/types'

const router = useRouter()
const route = useRoute()
const { user } = useAuth()
const { hl } = useHlStatus()

const projects = ref<Project[]>([])
const loading = ref(true)
const createOpen = ref(false)
const name = ref('')
const description = ref('')
const creating = ref(false)
const pendingDelete = ref<Project | null>(null)
const deleting = ref(false)

const unsubscribe = onSnapshot(
  query(collection(db, 'projects'), where('ownerId', '==', user.value!.uid), where('deleted', '==', false), orderBy('updatedAt', 'desc')),
  (snap) => {
    projects.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Project)
    loading.value = false
  },
  (err) => {
    loading.value = false
    toast.error(`Could not load projects: ${err.message}`)
  },
)
onScopeDispose(unsubscribe)

// Result of the HighLevel OAuth round-trip (the callback function redirects here).
onMounted(async () => {
  // Successful install: the callback hands code+state over in the fragment and this
  // signed-in tab finishes it, so the state must belong to this account.
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const code = hash.get('hl_code')
  const state = hash.get('hl_state')
  if (code && state) {
    history.replaceState(null, '', window.location.pathname)
    try {
      await apiFetch('/hl/complete', { method: 'POST', body: { code, state } })
      toast.success('HighLevel connected')
    } catch (err) {
      toast.error('Could not connect HighLevel', { description: errorMessage(err) })
    }
    return
  }
  const status = route.query.hl
  if (status === 'connected') toast.success('HighLevel connected')
  if (status === 'error') {
    const reasons: Record<string, string> = {
      missing_state: 'HighLevel did not return the security state. Please use the Connect button.',
      missing_code: 'HighLevel did not return an authorization code. Please try again.',
    }
    toast.error('Could not connect HighLevel', { description: reasons[String(route.query.reason)] ?? String(route.query.reason ?? '') })
  }
  if (status) router.replace({ query: {} })
})

async function createProject() {
  if (!name.value.trim()) return
  creating.value = true
  try {
    const ref = await addDoc(collection(db, 'projects'), {
      ownerId: user.value!.uid,
      name: name.value.trim().slice(0, 80),
      description: description.value.trim().slice(0, 500),
      locationId: hl.value.locationId ?? null,
      deleted: false,
      activeGeneration: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    createOpen.value = false
    name.value = ''
    description.value = ''
    await router.push(`/projects/${ref.id}`)
  } catch (err) {
    toast.error(`Could not create project: ${(err as Error).message}`)
  } finally {
    creating.value = false
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  deleting.value = true
  try {
    // Soft delete: the project disappears from lists but its history is kept.
    await updateDoc(doc(db, 'projects', pendingDelete.value.id), { deleted: true, updatedAt: serverTimestamp() })
    toast.success(`Deleted "${pendingDelete.value.name}"`)
    pendingDelete.value = null
  } catch (err) {
    toast.error(`Could not delete: ${(err as Error).message}`)
  } finally {
    deleting.value = false
  }
}

async function logout() {
  await endSession()
  await router.replace('/login')
}

const formatDate = (p: Project) => p.updatedAt?.toDate().toLocaleString() ?? 'Just now'
</script>

<template>
  <div class="min-h-screen bg-muted/30">
    <header class="border-b bg-background">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div class="flex items-center gap-2 font-semibold"><SparklesIcon class="size-5 text-primary" /> Genesis</div>
        <div class="flex items-center gap-3 text-sm text-muted-foreground">
          <span class="hidden sm:inline">{{ user?.email }}</span>
          <Button variant="ghost" size="sm" @click="logout"><LogOutIcon /> Sign out</Button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-8 px-4 py-8">
      <HighLevelConnection />

      <section class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">Projects</h2>
          <Button @click="createOpen = true"><PlusIcon /> New project</Button>
        </div>

        <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton v-for="i in 3" :key="i" class="h-32 rounded-xl" />
        </div>

        <Card v-else-if="!projects.length" class="items-center py-12 text-center">
          <FolderCodeIcon class="size-10 text-muted-foreground" />
          <CardHeader class="w-full">
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>Create a project, then describe the HighLevel app you want in the chat.</CardDescription>
          </CardHeader>
          <Button @click="createOpen = true"><PlusIcon /> Create your first project</Button>
        </Card>

        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            v-for="p in projects"
            :key="p.id"
            class="cursor-pointer transition hover:border-primary/40 hover:shadow-sm"
            @click="router.push(`/projects/${p.id}`)"
          >
            <CardHeader>
              <CardTitle class="truncate">{{ p.name }}</CardTitle>
              <CardDescription class="line-clamp-2 min-h-10">{{ p.description || 'No description' }}</CardDescription>
            </CardHeader>
            <CardFooter class="justify-between text-xs text-muted-foreground">
              <span>{{ isGenerating(p) ? 'Generating...' : `Updated ${formatDate(p)}` }}</span>
              <Button variant="ghost" size="icon-sm" aria-label="Delete project" @click.stop="pendingDelete = p">
                <Trash2Icon />
              </Button>
            </CardFooter>
          </Card>
        </div>
      </section>
    </main>

    <Dialog v-model:open="createOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Give it a name. You will describe the app in the chat next.</DialogDescription>
        </DialogHeader>
        <form class="space-y-3" @submit.prevent="createProject">
          <div class="space-y-1.5">
            <Label for="p-name">Name</Label>
            <Input id="p-name" v-model="name" maxlength="80" placeholder="Contact dashboard" required />
          </div>
          <div class="space-y-1.5">
            <Label for="p-desc">Description (optional)</Label>
            <Textarea id="p-desc" v-model="description" maxlength="500" rows="3" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="createOpen = false">Cancel</Button>
            <Button type="submit" :disabled="creating || !name.trim()">
              <Loader2Icon v-if="creating" class="animate-spin" /> Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!pendingDelete" @update:open="(o: boolean) => !o && (pendingDelete = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{{ pendingDelete?.name }}"?</DialogTitle>
          <DialogDescription>The project will be removed from your dashboard.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingDelete = null">Cancel</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <Loader2Icon v-if="deleting" class="animate-spin" /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
