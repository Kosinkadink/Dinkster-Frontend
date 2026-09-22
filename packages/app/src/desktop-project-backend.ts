import type { DesktopProjectEngineInfo } from './desktop-bridge.js'

/**
 * Base URL for the window's default backend: the configured project
 * supervisor's loopback port, or undefined when the report gives no usable
 * port. An undefined answer means fail closed - the window must not fall
 * back to a same-origin backend the project does not own.
 */
export function desktopProjectBackendBaseUrl(project: DesktopProjectEngineInfo): string | undefined {
  if (!project.configured) return undefined
  const port = project.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return `http://127.0.0.1:${port}`
}
