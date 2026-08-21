<script setup lang="ts">
import { useSidebar } from '@/components/ui/sidebar'
import { useSidebarResize } from '@/composables/use-sidebar-resize'

const { open, setOpen, toggleSidebar } = useSidebar()
const { defaultWidth, iconWidth, setSidebarWidth } = useSidebarResize()

function startResize(event: PointerEvent) {
  if (event.button !== 0) return
  if (!(event.currentTarget instanceof HTMLElement)) return
  const target = event.currentTarget
  const startX = event.clientX
  let dragged = false

  target.setPointerCapture(event.pointerId)
  const resize = (moveEvent: PointerEvent) => {
    const width = Math.min(moveEvent.clientX, window.innerWidth - iconWidth)
    dragged ||= Math.abs(moveEvent.clientX - startX) > 0
    const collapseThreshold = (defaultWidth + iconWidth) / 2
    if (width <= collapseThreshold) {
      setOpen(false)
      return
    }
    setSidebarWidth(width)
    setOpen(true)
  }
  const finish = (upEvent: PointerEvent) => {
    target.releasePointerCapture(upEvent.pointerId)
    target.removeEventListener('pointermove', resize)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    if (!dragged) toggleSidebar()
  }

  target.addEventListener('pointermove', resize)
  target.addEventListener('pointerup', finish)
  target.addEventListener('pointercancel', finish)
}
</script>

<template>
  <button
    data-sidebar="rail"
    aria-label="Resize or toggle sidebar"
    :aria-expanded="open"
    :tabindex="-1"
    title="Resize or toggle sidebar"
    class="hover:after:bg-sidebar-border absolute inset-y-0 -right-4 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 sm:flex [[data-state=collapsed]_&]:cursor-e-resize"
    @pointerdown="startResize"
  />
</template>
