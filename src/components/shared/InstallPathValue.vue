<script setup lang="ts">
defineProps<{
  path: string
  label?: string
  focusable?: boolean
}>()
</script>

<template>
  <span class="group/path relative block min-w-0">
    <span
      class="text-foreground focus-visible:ring-ring block min-w-0 truncate rounded-sm font-mono text-xs outline-none focus-visible:ring-2"
      :tabindex="focusable === false ? undefined : 0"
      :aria-label="`${label ?? 'Install path'}: ${path}`"
    >
      {{ path }}
    </span>
    <span
      class="bg-popover text-popover-foreground pointer-events-none absolute bottom-full left-0 z-50 mb-1 hidden max-w-[min(32rem,80vw)] rounded-md px-2 py-1 font-mono text-xs break-all shadow-md group-focus-within/path:block group-hover/path:block"
      aria-hidden="true"
    >
      {{ path }}
    </span>
  </span>
</template>
