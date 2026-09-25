import { request } from './transport'

export function checkApplicationUpdate() {
  return request('checkApplicationUpdate', {})
}

export function refreshApplicationUpdate() {
  return request('refreshApplicationUpdate', {})
}

export function installApplicationUpdate() {
  return request('installApplicationUpdate', {})
}
