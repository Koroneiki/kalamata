<script setup lang="ts">
import { ImageOff } from '@lucide/vue'
import { ref } from 'vue'

defineProps<{
  name: string
  iconUrl: string | null
  message: string
}>()

const iconFailed = ref(false)
</script>

<template>
  <div class="flex min-w-0 items-center gap-3.5 p-3.5 pr-5">
    <div
      class="border-primary/25 bg-muted grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border"
    >
      <img
        v-if="iconUrl && !iconFailed"
        class="size-full object-cover"
        :src="iconUrl"
        alt=""
        @error="iconFailed = true"
      />
      <ImageOff
        v-else
        class="text-muted-foreground size-5"
        aria-hidden="true"
      />
    </div>
    <div class="min-w-0">
      <p class="truncate text-sm leading-5 font-semibold">{{ name }}</p>
      <p class="text-muted-foreground mt-0.5 text-xs leading-4">
        {{ message }}
      </p>
    </div>
  </div>
</template>
