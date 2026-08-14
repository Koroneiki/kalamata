import { computed, ref, watch } from 'vue'

export function useFallbackImage(
  sources: () => readonly string[] | null | undefined,
) {
  const index = ref(0)

  watch(sources, () => {
    index.value = 0
  })

  const imageUrl = computed(() => sources()?.[index.value] ?? null)

  function handleImageError() {
    index.value += 1
  }

  return { imageUrl, handleImageError }
}
