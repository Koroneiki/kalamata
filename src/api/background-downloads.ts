import { request } from './transport'

export const getBackgroundDownloads = () =>
  request('getBackgroundDownloads', {})
export const prioritizeBackgroundDownload = (id: string) =>
  request('prioritizeBackgroundDownload', { id })
