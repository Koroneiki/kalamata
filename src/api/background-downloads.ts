import { request } from './transport'

export const getBackgroundDownloads = () =>
  request('getBackgroundDownloads', {})
export const prioritizeBackgroundDownload = (id: string) =>
  request('prioritizeBackgroundDownload', { id })
export const retryBackgroundDownload = (id: string) =>
  request('retryBackgroundDownload', { id })
export const dismissBackgroundDownload = (id: string) =>
  request('dismissBackgroundDownload', { id })
