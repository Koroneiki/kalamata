<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const router = useRouter()
const appId = ref('')
const error = ref('')

function search() {
  const value = Number(appId.value)
  if (!/^\d+$/.test(appId.value) || value <= 0 || value > 0xffffffff) {
    error.value = 'Enter a valid App ID.'
    return
  }

  error.value = ''
  void router.push({ name: 'app-details', params: { appId: value } })
}
</script>

<template>
  <main class="grid min-h-screen place-items-center p-6">
    <form class="w-full max-w-md space-y-3" @submit.prevent="search">
      <Label for="app-id">Steam App ID</Label>
      <div class="flex gap-2">
        <Input
          id="app-id"
          v-model="appId"
          class="flex-1"
          inputmode="numeric"
          placeholder="440"
          autofocus
        />
        <Button type="submit">Search</Button>
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    </form>
  </main>
</template>
