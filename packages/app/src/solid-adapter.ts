/**
 * Core-signal -> Solid adapter. The core store stays framework-free; Solid
 * components opt in per signal. This file is the entire coupling surface
 * between the shell framework and the core (the "low-stakes choice" design).
 */

import { createSignal as createSolidSignal, onCleanup, type Accessor } from 'solid-js'
import type { ReadonlySignal } from '@dinkster/core'

export function useSignal<T>(signal: ReadonlySignal<T>): Accessor<T> {
  const [get, set] = createSolidSignal<T>(signal.get(), { equals: false })
  const unsubscribe = signal.subscribe((v) => set(() => v))
  onCleanup(unsubscribe)
  return get
}
