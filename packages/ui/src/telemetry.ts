export type ProductRoute =
  | 'gallery'
  | 'account'
  | 'registry'
  | 'authorization'
  | 'app'
  | 'desktop-about'
export type ProductAction =
  | 'navigate'
  | 'save'
  | 'create'
  | 'remove'
  | 'sign-in'
  | 'sign-out'
  | 'authorize'
export type ProductEvent =
  | { type: 'page-viewed'; route: ProductRoute }
  | {
      type: 'action-completed' | 'action-failed'
      route: ProductRoute
      action: ProductAction
    }
  | {
      type: 'load-timing' | 'interaction-timing'
      route: ProductRoute
      durationMs: number
    }

// No provider, storage or transport is installed until the event list is approved.
export function reportProductEvent(_event: ProductEvent): void {}
