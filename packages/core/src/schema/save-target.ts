export type SaveTarget = { mount: string; prefix: string }
/** A target on Project default names no mount; each project supplies its own. */
export type ProjectDefaultTarget = { prefix: string }

const usablePrefix = (prefix: unknown): prefix is string =>
  typeof prefix === 'string' && prefix !== '' && !prefix.includes('\\')
  && prefix.split('/').every((segment) => !['', '.', '..'].includes(segment))

export const isSaveTarget = (value: unknown): value is SaveTarget => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  return Object.keys(target).length === 2 && typeof target['mount'] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(target['mount'])
    && usablePrefix(target['prefix'])
}

export const isProjectDefaultTarget = (value: unknown): value is ProjectDefaultTarget =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === 1 && usablePrefix((value as Record<string, unknown>)['prefix'])
