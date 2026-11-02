<script setup lang="ts">
import { CheckCircle2Icon, Loader2Icon, PlugIcon, TriangleAlertIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHlStatus } from '@/composables/useHlStatus'
import { apiFetch, errorMessage } from '@/lib/api'

const { hl, connected, loaded } = useHlStatus()
const connecting = ref(false)
const disconnecting = ref(false)

async function connect() {
  connecting.value = true
  try {
    const { url } = await apiFetch<{ url: string }>('/hl/authorize-url')
    window.location.assign(url) // full redirect into HighLevel's OAuth consent screen
  } catch (err) {
    toast.error(errorMessage(err))
    connecting.value = false
  }
}

async function disconnect() {
  disconnecting.value = true
  try {
    await apiFetch('/hl/disconnect', { method: 'POST' })
    toast.success('HighLevel disconnected')
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    disconnecting.value = false
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        HighLevel connection
        <Skeleton v-if="!loaded" class="h-5 w-24" />
        <Badge v-else-if="connected" variant="secondary" class="gap-1">
          <CheckCircle2Icon class="size-3 text-green-600" /> Connected
        </Badge>
        <Badge v-else-if="hl.status === 'expired'" variant="destructive" class="gap-1">
          <TriangleAlertIcon class="size-3" /> Expired
        </Badge>
        <Badge v-else variant="outline">Not connected</Badge>
      </CardTitle>
      <CardDescription>
        <template v-if="connected">
          Generated apps read live data from <span class="font-medium text-foreground">{{ hl.locationName || hl.locationId }}</span
          >.
        </template>
        <template v-else-if="hl.status === 'expired'">Your HighLevel session expired. Reconnect to keep previews working.</template>
        <template v-else
          >Connect a HighLevel sub-account so generated apps can show real contacts, conversations and appointments.</template
        >
      </CardDescription>
    </CardHeader>
    <CardContent class="flex gap-2">
      <Button v-if="!connected" :disabled="connecting || !loaded" @click="connect">
        <Loader2Icon v-if="connecting" class="animate-spin" />
        <PlugIcon v-else />
        {{ hl.status === 'expired' ? 'Reconnect HighLevel' : 'Connect HighLevel' }}
      </Button>
      <template v-else>
        <Button variant="outline" :disabled="connecting" @click="connect">Switch location</Button>
        <Button variant="ghost" :disabled="disconnecting" @click="disconnect">
          <Loader2Icon v-if="disconnecting" class="animate-spin" />
          Disconnect
        </Button>
      </template>
    </CardContent>
  </Card>
</template>
