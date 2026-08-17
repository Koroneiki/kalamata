import { defineStore } from 'pinia'
import { reactive } from 'vue'

import type { DepotManifestTarget } from '../types/rpc'

interface DepotOperationDraft {
  depotIds: number[]
  manifestTargets: DepotManifestTarget[]
}

export function normalizeDepotDraftEdit(
  depotIds: number[],
  eligibleDepotIds: ReadonlySet<number>,
) {
  return depotIds.some((depotId) => eligibleDepotIds.has(depotId))
    ? depotIds
    : []
}

export const useDepotOperationDraftStore = defineStore(
  'depot-operation-drafts',
  () => {
    const drafts = reactive(new Map<number, DepotOperationDraft>())

    function get(appId: number) {
      return drafts.get(appId) ?? null
    }

    function editDepotIds(appId: number, depotIds: number[]) {
      const current = drafts.get(appId)
      const selected = new Set(depotIds)
      drafts.set(appId, {
        depotIds: [...depotIds],
        manifestTargets: (current?.manifestTargets ?? []).filter(
          ({ depotId }) => selected.has(depotId),
        ),
      })
    }

    function setManifestTarget(
      appId: number,
      baselineDepotIds: number[],
      target: DepotManifestTarget,
    ) {
      const current = drafts.get(appId) ?? {
        depotIds: [...baselineDepotIds],
        manifestTargets: [],
      }
      const depotIds = current.depotIds.includes(target.depotId)
        ? current.depotIds
        : [...current.depotIds, target.depotId]
      drafts.set(appId, {
        depotIds,
        manifestTargets: [
          ...current.manifestTargets.filter(
            ({ depotId }) => depotId !== target.depotId,
          ),
          target,
        ],
      })
    }

    function removeManifestTarget(appId: number, depotId: number) {
      const current = drafts.get(appId)
      if (!current) return
      current.manifestTargets = current.manifestTargets.filter(
        (target) => target.depotId !== depotId,
      )
    }

    function prune(appId: number, retainedDepotIds: ReadonlySet<number>) {
      const current = drafts.get(appId)
      if (!current) return
      const depotIds = current.depotIds.filter((depotId) =>
        retainedDepotIds.has(depotId),
      )
      const selected = new Set(depotIds)
      current.depotIds = depotIds
      current.manifestTargets = current.manifestTargets.filter(({ depotId }) =>
        selected.has(depotId),
      )
    }

    function clear(appId: number) {
      drafts.delete(appId)
    }

    return {
      get,
      editDepotIds,
      setManifestTarget,
      removeManifestTarget,
      prune,
      clear,
    }
  },
)
