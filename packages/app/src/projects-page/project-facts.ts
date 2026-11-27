import type { LibraryProject } from '@dinkster/client'

/** Last opening in milliseconds since the epoch, or null when never opened. */
export function projectTime(project: Pick<LibraryProject, 'lastOpenedAt'>): number | null {
  return project.lastOpenedAt ? Date.parse(project.lastOpenedAt) : null
}

/** Most recently opened first; never-opened projects retain their list order last. */
export function byProjectTime<T extends Pick<LibraryProject, 'lastOpenedAt'>>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => (projectTime(b) ?? -Infinity) - (projectTime(a) ?? -Infinity))
}

const DAY = 24 * 60 * 60 * 1000

/**
 * When something happened, for a line such as "Opened {when}": relative within
 * the last week ("2 hours ago", "yesterday"), a date after that ("Nov 12"),
 * with the year once it is not this year.
 */
export function formatWhen(at: number, locale: string, now: number = Date.now()): string {
  const age = now - at
  if (age < DAY * 7) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (age < 60 * 1000) return relative.format(0, 'second')
    if (age < 60 * 60 * 1000) return relative.format(-Math.floor(age / (60 * 1000)), 'minute')
    if (age < DAY) return relative.format(-Math.floor(age / (60 * 60 * 1000)), 'hour')
    return relative.format(-Math.floor(age / DAY), 'day')
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(at)
}
