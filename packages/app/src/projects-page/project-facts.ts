import type { LibraryProject } from '@dinkster/client'

/**
 * The time the projects page shows for a project. Nothing records when a
 * project was last opened, so it is the start of the project's newest run, or
 * when the project was made if it has never run.
 */
export interface ProjectTime {
  readonly kind: 'ran' | 'created'
  /** Milliseconds since the epoch. */
  readonly at: number
}

export function projectTime(project: Pick<LibraryProject, 'created' | 'environment'>): ProjectTime {
  const created = Date.parse(project.created)
  const lastRun = project.environment?.lastRunAt
  const ran = lastRun ? Date.parse(lastRun) : Number.NaN
  return ran >= created ? { kind: 'ran', at: ran } : { kind: 'created', at: created }
}

/** Projects newest first by the time the page shows for them. */
export function byProjectTime<T extends Pick<LibraryProject, 'created' | 'environment'>>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => projectTime(b).at - projectTime(a).at)
}

const DAY = 24 * 60 * 60 * 1000

/**
 * When something happened, for a line such as "Ran {when}": relative within
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

/** A size such as "3.1 GB", in decimal units as file managers show them. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value)
}
