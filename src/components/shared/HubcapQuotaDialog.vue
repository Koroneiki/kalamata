<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useHubcapApproval } from '@/composables/use-hubcap-approval'

const { current, decide } = useHubcapApproval()
</script>

<template>
  <Dialog :open="Boolean(current)" @update:open="!$event && decide(false)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Use a Hubcap request?</DialogTitle>
        <DialogDescription>
          You have used {{ current?.usage.dailyUsage }} of
          {{ current?.usage.dailyLimit }} requests today. Continuing spends one
          request and leaves
          {{ Math.max(0, (current?.usage.remaining ?? 1) - 1) }}.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" @click="decide(false)">
          Cancel
        </Button>
        <Button type="button" @click="decide(true)">Continue</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
