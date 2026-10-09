import { request } from './transport'

export const getBackgroundDownloads = () =>
  request('getBackgroundDownloads', {})
