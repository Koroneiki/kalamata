import { ref } from 'vue'

const DEFAULT_SIDEBAR_WIDTH = 16 * 16
const ICON_SIDEBAR_WIDTH = 3 * 16
const STORAGE_KEY = 'sidebar_width'

function storedWidth() {
  const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY))
  return Number.isFinite(value) && value > ICON_SIDEBAR_WIDTH
    ? value
    : DEFAULT_SIDEBAR_WIDTH
}

const sidebarWidth = ref(storedWidth())

export function useSidebarResize() {
  function setSidebarWidth(width: number) {
    sidebarWidth.value = width
    globalThis.localStorage?.setItem(STORAGE_KEY, String(width))
  }

  return {
    sidebarWidth,
    defaultWidth: DEFAULT_SIDEBAR_WIDTH,
    iconWidth: ICON_SIDEBAR_WIDTH,
    setSidebarWidth,
  }
}
