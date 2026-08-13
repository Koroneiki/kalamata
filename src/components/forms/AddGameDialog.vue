<script setup lang="ts">
import { Search } from '@lucide/vue'
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { steamIdStringSchema } from '@/types/schemas'

const router = useRouter()
const emit = defineEmits<{ navigated: [] }>()
const open = ref(false)
const appId = ref('')
const searchError = ref('')

async function search() {
  const result = steamIdStringSchema.safeParse(appId.value)
  if (!result.success) {
    searchError.value = 'Enter an App ID from 1 to 4294967295.'
    return
  }

  searchError.value = ''
  await router.push({ name: 'app-details', params: { appId: result.data } })
  emit('navigated')
  open.value = false
  appId.value = ''
}

watch(open, (isOpen) => {
  if (isOpen) return

  appId.value = ''
  searchError.value = ''
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <slot />
    </DialogTrigger>
    <DialogContent>
      <form novalidate @submit.prevent="search">
        <DialogHeader>
          <DialogTitle>Add a game</DialogTitle>
          <DialogDescription>
            Enter a Steam App ID to inspect its available content before
            installing it.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-5">
          <Label for="add-game-app-id">Steam App ID</Label>
          <Input
            id="add-game-app-id"
            v-model.trim="appId"
            class="mt-2 tabular-nums"
            inputmode="numeric"
            autocomplete="off"
            placeholder="For example, 440"
            :aria-invalid="Boolean(searchError)"
            :aria-describedby="
              searchError ? 'add-game-search-error' : undefined
            "
            autofocus
          />
          <p
            v-if="searchError"
            id="add-game-search-error"
            class="text-destructive mt-2 text-sm"
            role="alert"
          >
            {{ searchError }}
          </p>
        </div>

        <DialogFooter class="mt-5">
          <Button type="submit">
            <Search aria-hidden="true" />
            Search
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
