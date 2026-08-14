import { defineQueryOptions, useQuery } from '@pinia/colada'
import { toValue, type MaybeRefOrGetter } from 'vue'

import { getAppSummary } from '@/api/apps'
import { getLibrary } from '@/api/library'
import { getSettings } from '@/api/settings'

export const appQueryKeys = {
  summary: (appId: number) => ['app-summary', appId] as const,
  details: (appId: number) => ['app', appId] as const,
}

export const libraryQueryKey = ['library'] as const
export const settingsQueryKey = ['settings'] as const

const appSummaryQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.summary(appId),
  query: () => getAppSummary(appId),
}))

const libraryQuery = defineQueryOptions({
  key: libraryQueryKey,
  query: getLibrary,
})

const settingsQuery = defineQueryOptions({
  key: settingsQueryKey,
  query: getSettings,
})

export function useAppSummaryQuery(appId: MaybeRefOrGetter<number>) {
  return useQuery(() => appSummaryQuery(toValue(appId)))
}

export function useLibraryQuery() {
  return useQuery(libraryQuery)
}

export function useSettingsQuery() {
  return useQuery(settingsQuery)
}
