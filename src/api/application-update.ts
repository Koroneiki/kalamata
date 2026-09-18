import { request } from './transport'

export function checkApplicationUpdate() {
  return request('checkApplicationUpdate', {})
}

export function installApplicationUpdate() {
  return request('installApplicationUpdate', {})
}
