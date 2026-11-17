export interface ModelProviderStatus {
  readonly provider: 'huggingface'
  readonly configured: boolean
  readonly expired?: boolean
}

export type ModelProviderSignIn =
  | { readonly flowId: string; readonly method: 'pkce'; readonly authorizationUrl: string }
  | { readonly flowId: string; readonly method: 'device'; readonly verificationUri: string; readonly userCode: string; readonly interval: number; readonly expiresIn: number }

export interface ModelProviderPoll {
  readonly status: 'pending' | 'signed-in' | 'cancelled'
  readonly interval?: number
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid provider response')
  return raw as Record<string, unknown>
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) throw new Error('Invalid provider response')
  return value
}

function providerUrl(value: string, path?: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.host !== 'huggingface.co' || url.username || url.password ||
    (path !== undefined && url.pathname !== path)) throw new Error('Invalid provider URL')
  return url.href
}

export function decodeModelProviderStatus(raw: unknown): ModelProviderStatus {
  const row = object(raw)
  if (row['provider'] !== 'huggingface' || typeof row['configured'] !== 'boolean' ||
    (row['expired'] !== undefined && typeof row['expired'] !== 'boolean')) throw new Error('Invalid provider status')
  return { provider: 'huggingface', configured: row['configured'], ...(row['expired'] === true ? { expired: true } : {}) }
}

export function decodeModelProviderSignIn(raw: unknown): ModelProviderSignIn {
  const row = object(raw)
  const flowId = text(row, 'flowId')
  if (row['method'] === 'pkce') return { flowId, method: 'pkce', authorizationUrl: providerUrl(text(row, 'authorizationUrl'), '/oauth/authorize') }
  if (row['method'] !== 'device' || !Number.isSafeInteger(row['interval']) || (row['interval'] as number) < 1 ||
    (row['interval'] as number) > 60 || !Number.isSafeInteger(row['expiresIn']) || (row['expiresIn'] as number) < 1 ||
    (row['expiresIn'] as number) > 3600) throw new Error('Invalid provider sign-in')
  return { flowId, method: 'device', verificationUri: providerUrl(text(row, 'verificationUri')),
    userCode: text(row, 'userCode'), interval: row['interval'] as number, expiresIn: row['expiresIn'] as number }
}

export function decodeModelProviderPoll(raw: unknown): ModelProviderPoll {
  const row = object(raw)
  if (row['status'] !== 'pending' && row['status'] !== 'signed-in' && row['status'] !== 'cancelled') throw new Error('Invalid provider sign-in status')
  if (row['interval'] !== undefined && (!Number.isSafeInteger(row['interval']) ||
    (row['interval'] as number) < 1 || (row['interval'] as number) > 300)) throw new Error('Invalid provider polling interval')
  return { status: row['status'], ...(row['interval'] !== undefined ? { interval: row['interval'] as number } : {}) }
}
