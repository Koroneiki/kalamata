import { defineStore } from 'pinia'
import { ref } from 'vue'

interface ManifestQueueState {
  id: number
  completed: number
  total: number
}

export const useManifestQueueStore = defineStore('manifest-queue', () => {
  const state = ref<ManifestQueueState | null>(null)
  let nextId = 1

  function begin(count: number) {
    if (state.value) {
      state.value = { ...state.value, total: state.value.total + count }
      return state.value.id
    }

    const id = nextId++
    state.value = { id, completed: 0, total: count }
    return id
  }

  function settle(id: number) {
    if (state.value?.id !== id) return
    const completed = state.value.completed + 1
    state.value =
      completed >= state.value.total ? null : { ...state.value, completed }
  }

  return { state, begin, settle }
})
