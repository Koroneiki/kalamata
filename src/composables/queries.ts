import { defineQueryOptions, useQuery } from '@pinia/colada'
import { toValue, type MaybeRefOrGetter } from 'vue'

import { getAppDetails, getAppSummary } from '@/api/apps'
import { getLibrary } from '@/api/library'

export const appQueryKeys = {
  summary: (appId: number) => ['app-summary', appId] as const,
  details: (appId: number) => ['app', appId] as const,
}

export const libraryQueryKey = ['library'] as const

export const appSummaryQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.summary(appId),
  query: () => getAppSummary(appId),
}))

export const appDetailsQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.details(appId),
  query: () => getAppDetails(appId),
}))

export const libraryQuery = defineQueryOptions({
  key: libraryQueryKey,
  query: getLibrary,
})

export function useAppSummaryQuery(appId: MaybeRefOrGetter<number>) {
  return useQuery(() => appSummaryQuery(toValue(appId)))
}

export function useAppDetailsQuery(appId: MaybeRefOrGetter<number>) {
  return useQuery(() => appDetailsQuery(toValue(appId)))
}

export function useLibraryQuery() {
  return useQuery(libraryQuery)
}
