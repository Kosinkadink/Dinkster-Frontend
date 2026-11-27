import { RequestFailure, requestFailureReason } from '@dinkster/client'
import { t } from '@dinkster/core'

export function failureMessage(error: unknown, sentence = t('request.failure')): string {
  const reason = requestFailureReason(error, {
    unanswered: t('request.reason.unanswered'),
    access: t('request.reason.access'),
    server: t('request.reason.server'),
  })
  return reason === undefined ? sentence : `${sentence} ${reason}`
}

export function folderFailureMessage(error: unknown, onFailure?: (detail: string) => void): string {
  const detail = error instanceof RequestFailure ? error.serverMessage ?? error.message
    : error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (detail) onFailure?.(detail)
  if (/not a directory|not a folder|ENOTDIR/i.test(detail)) return t('storagePanel.notFolder')
  if (/permission denied|not allowed to read|EACCES|EPERM/i.test(detail)) return t('storagePanel.readDenied')
  return t('storagePanel.unreachable')
}
