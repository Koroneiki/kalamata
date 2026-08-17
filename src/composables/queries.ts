import { defineQueryOptions, useQuery } from '@pinia/colada'
import { toValue, type MaybeRefOrGetter } from 'vue'

import {
  checkAvailableUpdate,
  checkAvailableUpdates,
  getAppDetails,
  getAppSummary,
} from '@/api/apps'
import { getLibrary } from '@/api/library'
import { getSettings } from '@/api/settings'

export const appQueryKeys = {
  summary: (appId: number) => ['app-summary', appId] as const,
  details: (appId: number) => ['app', appId] as const,
  availableUpdate: (appId: number) => ['available-update', appId] as const,
}

export const libraryQueryKey = ['library'] as const
export const settingsQueryKey = ['settings'] as const

const appSummaryQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.summary(appId),
  query: () => getAppSummary(appId),
}))

export const appDetailsQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.details(appId),
  query: () => getAppDetails(appId),
}))

export const availableUpdateQuery = defineQueryOptions((appId: number) => ({
  key: appQueryKeys.availableUpdate(appId),
  query: () => fetchAvailableUpdate(appId),
}))

export async function fetchAvailableUpdate(appId: number) {
  try {
    return await checkAvailableUpdate(appId)
  } catch {
    return {
      status: 'error' as const,
      appId,
      message: 'Could not check this app for updates.',
      checkedAt: Date.now(),
    }
  }
}

export async function fetchAvailableUpdates(appIds: number[]) {
  try {
    return await checkAvailableUpdates(appIds)
  } catch {
    return appIds.map((appId) => ({
      status: 'error' as const,
      appId,
      message: 'Could not check this app for updates.',
      checkedAt: Date.now(),
    }))
  }
}

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
