import { requestFailureReason } from '@dinkster/client'
import { t } from '@dinkster/core'

export function failureMessage(error: unknown, sentence = t('request.failure')): string {
  const reason = requestFailureReason(error, {
    unanswered: t('request.reason.unanswered'),
    access: t('request.reason.access'),
    server: t('request.reason.server'),
  })
  return reason === undefined ? sentence : `${sentence} ${reason}`
}
