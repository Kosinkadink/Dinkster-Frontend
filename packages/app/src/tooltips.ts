import { defaultTokens, presentedType, typeIdDisplayLabel } from '@dinkster/canvas'
import { effectiveAbsentPolicy, effectiveWidgetDefault, formatWidgetValue, t as translate } from '@dinkster/core'
import type { InputSpec, RegionContract, TypeExpr } from '@dinkster/core'

export interface TooltipContent {
  readonly title?: string
  readonly lines: readonly string[]
  readonly detail?: readonly string[]
}

export interface TooltipResolveOptions { readonly detailed: boolean }
export interface TooltipProvider {
  readonly id: string
  resolve(target: unknown, opts: TooltipResolveOptions): TooltipContent | undefined
}
export interface TooltipAnchor { readonly x: number; readonly y: number }
export interface VisibleTooltip extends TooltipContent { readonly x: number; readonly y: number; readonly detailed: boolean }

/** One tooltip policy boundary shared by DOM chrome and the painted canvas. */
export class TooltipController {
  private readonly providers: TooltipProvider[] = []
  private listeners = new Set<() => void>()
  private pending: ReturnType<typeof setTimeout> | undefined
  private candidate: { target: unknown; anchor: TooltipAnchor; owner: unknown } | undefined
  private current: VisibleTooltip | undefined
  private currentTarget: unknown
  private currentOwner: unknown
  private detailed = false

  constructor(private readonly delayMs: () => number = () => 500) {}

  register(provider: TooltipProvider): () => void {
    if (this.providers.some((p) => p.id === provider.id)) throw new Error(`tooltip provider '${provider.id}' already registered`)
    this.providers.push(provider)
    return () => {
      const index = this.providers.indexOf(provider)
      if (index >= 0) this.providers.splice(index, 1)
    }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get visible(): VisibleTooltip | undefined { return this.current }

  show(target: unknown, anchor: TooltipAnchor, detailed = this.detailed, immediate = false, owner?: unknown): void {
    this.clearTimer()
    this.candidate = { target, anchor, owner }
    this.detailed = detailed
    if (detailed || immediate) this.resolveNow()
    else this.pending = setTimeout(() => this.resolveNow(), Math.max(0, this.delayMs()))
  }

  /** Replace a target inside one hover session without restarting its initial delay. */
  showInSession(target: unknown, anchor: TooltipAnchor, detailed = this.detailed): void {
    if (this.current) {
      this.show(target, anchor, detailed, true)
      return
    }
    if (this.pending !== undefined) {
      this.candidate = { target, anchor, owner: undefined }
      this.detailed = detailed
      if (detailed) { this.clearTimer(); this.resolveNow() }
      return
    }
    this.show(target, anchor, detailed)
  }

  hide(): void {
    this.clearTimer()
    this.candidate = undefined
    this.currentTarget = undefined
    this.currentOwner = undefined
    if (this.current) { this.current = undefined; this.emit() }
  }

  /**
   * Hide only when the pending or visible tooltip's TARGET matches. Lets the
   * canvas invalidate its own scene-anchored tooltips (scene rebuilds, camera
   * moves) without cancelling DOM chrome tooltips that share this controller.
   * An owner limits invalidation to one producer on the shared surface.
   */
  hideMatching(predicate: (target: unknown) => boolean, owner?: unknown): void {
    const candidateMatches = this.candidate !== undefined &&
      (owner === undefined || this.candidate.owner === owner) && predicate(this.candidate.target)
    const currentMatches = this.current !== undefined &&
      (owner === undefined || this.currentOwner === owner) && predicate(this.currentTarget)
    if (candidateMatches) { this.clearTimer(); this.candidate = undefined }
    if (currentMatches) { this.current = undefined; this.currentTarget = undefined; this.currentOwner = undefined; this.emit() }
  }

  setDetailed(detailed: boolean): void {
    if (this.detailed === detailed) return
    this.detailed = detailed
    if (this.candidate) {
      this.clearTimer()
      // Alt is instant. Releasing Alt keeps the tooltip open but re-resolves basic content.
      this.resolveNow()
    }
  }

  private resolveNow(): void {
    const candidate = this.candidate
    if (!candidate) return
    const content = this.providers.map((p) => p.resolve(candidate.target, { detailed: this.detailed })).find(Boolean)
    this.current = content ? { ...content, x: candidate.anchor.x, y: candidate.anchor.y, detailed: this.detailed } : undefined
    this.currentTarget = content ? candidate.target : undefined
    this.currentOwner = content ? candidate.owner : undefined
    this.emit()
  }
  private clearTimer(): void { if (this.pending !== undefined) clearTimeout(this.pending); this.pending = undefined }
  private emit(): void { for (const listener of this.listeners) listener() }
}

export interface DomTooltipTarget { readonly kind: 'dom'; readonly label: string; readonly detail?: readonly string[] }

/** Time a visible tooltip may bridge empty space inside one hover session. */
export const DOM_TOOLTIP_SESSION_GRACE_MS = 300

const isDomTooltipTarget = (target: unknown): target is DomTooltipTarget =>
  typeof target === 'object' && target !== null && (target as { kind?: unknown }).kind === 'dom'

export interface CanvasTooltipContext {
  readonly resolveSchema?: (type: string) => any
  readonly resolvePack?: (id: string) => any
}

const joinedPorts = (ports: readonly string[] | undefined): string => ports?.join(', ') || 'its inputs'
const iterationLimit = (region: RegionContract): string =>
  region.maxIterations === undefined ? '' : `, up to ${region.maxIterations} iterations`

const outputSummary = (region: RegionContract): string => {
  const roles = Object.entries(region.outputRoles ?? {})
  if (roles.length === 0) return ' and gathers outputs'
  return `. Outputs: ${roles.map(([id, role]) => role.kind === 'flatten'
    ? `${id} flattened`
    : role.kind === 'compact'
      ? `${id} compacted`
    : role.kind === 'state'
      ? `${id} carries ${role.statePort} state`
      : `${id} gathered`).join('; ')}`
}

const absentPolicyLine = (input: InputSpec): string => {
  const policy = effectiveAbsentPolicy(input)
  const source = input.onAbsent === undefined
    ? translate(input.optional ? 'canvas.absence.source.optionalDefault' : 'canvas.absence.source.requiredDefault')
    : translate('canvas.absence.source.declared')
  const behavior = policy === 'skip'
    ? translate('canvas.absence.behavior.skip')
    : policy === 'omit'
      ? translate('canvas.absence.behavior.omit')
      : policy === 'accept'
        ? translate('canvas.absence.behavior.accept')
        : translate('canvas.absence.behavior.fail')
  const policyName = policy === 'skip'
    ? translate('canvas.absence.policy.skip')
    : policy === 'omit'
      ? translate('canvas.absence.policy.omit')
      : policy === 'accept'
        ? translate('canvas.absence.policy.accept')
        : translate('canvas.absence.policy.fail')
  return translate('canvas.absence.summary', { policy: policyName, source, behavior })
}

export function regionContractTooltip(region: RegionContract): TooltipContent {
  if (region.kind === 'map') {
    return {
      title: 'Map region',
      lines: [`Runs once per item from ${joinedPorts(region.elementPorts)} using ${region.binding ?? 'zip'} binding${iterationLimit(region)}${outputSummary(region)}.`],
    }
  }
  if (region.kind === 'fold') {
    return {
      title: 'Fold region',
      lines: [`Reduces items from ${joinedPorts(region.elementPorts)} through loop state ${joinedPorts(region.statePorts)}${region.binding === undefined ? '' : ` using ${region.binding} binding`}${iterationLimit(region)}.`],
    }
  }
  return {
    title: 'While region',
    lines: [`Repeats state ${joinedPorts(region.statePorts)} while ${region.continueOutput ?? 'the continuation output'} is true${region.maxIterations === undefined ? '.' : `, up to ${region.maxIterations} iterations.`}`],
  }
}

/** Original title only when the target is a genuinely renamed node header. */
export function renamedNodeHeaderOriginalTitle(
  target: unknown,
  context: CanvasTooltipContext = {},
): string | undefined {
  const t = target as any
  if (t.kind !== 'header') return undefined
  const node = t.hit.node.node
  const originalTitle = context.resolveSchema?.(node.type)?.displayName ?? node.type
  return node.title !== undefined && node.title !== originalTitle ? originalTitle : undefined
}

/** Unknown and renamed headers bypass the normal hover delay. */
export function nodeHeaderTooltipImmediate(
  target: unknown,
  context: CanvasTooltipContext = {},
): boolean {
  const t = target as any
  return t.kind === 'header' && (
    t.hit.node.unrecognized === true ||
    t.hit.node.missingSchema === true ||
    renamedNodeHeaderOriginalTitle(target, context) !== undefined
  )
}

/** Resolve painted-canvas targets. Kept pure so provider content is unit-testable. */
export function resolveCanvasTooltip(target: unknown, opts: TooltipResolveOptions, context: CanvasTooltipContext = {}): TooltipContent | undefined {
  const t = target as any
  if (t.kind === 'badge' && t.tooltip) return { lines: [t.tooltip.summary], ...(opts.detailed && t.tooltip.detail?.length ? { detail: t.tooltip.detail } : {}) }
  if (t.kind === 'toolbox') {
    const button = t.button.button
    return { lines: [button.label, ...(button.reason ? [button.reason] : [])] }
  }
  if (t.kind === 'controller') {
    const mode = t.hit.row.controllerMode as 'fixed' | 'increment' | 'decrement' | 'randomize'
    const afterRefresh = t.hit.row.spec.controller === 'after_refresh'
    const descriptions = afterRefresh ? {
      fixed: 'Keep this value after options refresh.',
      increment: 'Choose the next option after options refresh.',
      decrement: 'Choose the previous option after options refresh.',
      randomize: 'Choose a random option after options refresh.',
    } : {
      fixed: 'Keep this value after a run completes.',
      increment: 'Add the widget step after a run completes.',
      decrement: 'Subtract the widget step after a run completes.',
      randomize: 'Choose a new seed after a run completes.',
    }
    const titles = { fixed: 'Fixed', increment: 'Increment', decrement: 'Decrement', randomize: 'Randomize' }
    return {
      title: titles[mode],
      lines: [descriptions[mode]],
      ...(opts.detailed ? { detail: [afterRefresh
        ? `Only fresh remote responses advance stored values. Cache hits, errors, and linked values are not changed. ${t.connected ? 'Connected controls are inert.' : 'Click to choose a mode.'}`
        : `Only successful runs advance literal, submitted values. Linked values are not changed. ${t.connected ? 'Connected controls are inert.' : 'Click to choose a mode.'}`] } : {}),
    }
  }
  if (t.kind === 'reroute') {
    const rerouteTypeName: string | undefined = t.hit.reroute.typeName
    return { title: 'Reroute', lines: [rerouteTypeName !== undefined ? typeIdDisplayLabel(rerouteTypeName) : 'Any'] }
  }
  if (t.kind === 'link' && t.hit.link.mismatch === true && t.hit.link.diagnostics?.length > 0) {
    return {
      title: 'Type mismatch',
      lines: t.hit.link.diagnostics.map((diagnostic: { severity: string; message: string }) =>
        `[${diagnostic.severity}] ${diagnostic.message}`),
    }
  }
  if (t.kind === 'pin') {
    const schema = context.resolveSchema?.(t.hit.node.node.type)
    const port = schema?.items.find((item: any) => item.kind === (t.hit.direction === 'in' ? 'input' : 'output') && item.id === t.hit.portId)
    const type = presentedType(defaultTokens, t.hit.type)
    const matchVariable: string | undefined = t.hit.pin.matchVariable
    const matchConstraint = t.hit.pin.matchConstraint as TypeExpr | undefined
    const acceptedTypes = matchConstraint === undefined
      ? undefined
      : presentedType(defaultTokens, matchConstraint).label
    const matchDescription = matchVariable === undefined ? [] : [
      `Match type ${matchVariable}: every ${matchVariable} port on this node must resolve to the same type.`,
    ]
    return {
      title: `${t.hit.direction === 'in' ? 'Input' : 'Output'}: ${t.hit.pin.label ?? t.hit.portId}`,
      lines: [
        ...(t.hit.pin.inferred === true
          ? [`Resolved to ${type.tooltip}${acceptedTypes === undefined ? '.' : `; original constraint: ${acceptedTypes}.`}`]
          : matchVariable === undefined
            ? [type.tooltip]
            : acceptedTypes === undefined
              ? []
              : [`Accepts ${acceptedTypes}.`]),
        ...matchDescription,
        ...(t.hit.direction === 'in' && port?.kind === 'input' ? [absentPolicyLine(port)] : []),
        ...(t.hit.direction === 'out' && t.hit.pin.maybeAbsent === true ? ['May produce no value.'] : []),
        ...((t.diagnostics ?? []) as readonly { severity: string; message: string }[])
          .map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`),
      ],
      ...(opts.detailed && port?.tooltip ? { detail: [port.tooltip] } : {}),
    }
  }
  if (t.kind === 'widgetTap') {
    const type = presentedType(defaultTokens, t.hit.type)
    const row = t.hit.node.layout.rows.find((candidate: any) =>
      candidate.kind === 'widget' && candidate.inputId === t.hit.input)
    return {
      title: `Output: ${row?.label ?? t.hit.input}`,
      lines: [type.tooltip],
    }
  }
  if (t.kind === 'widget') {
    const row = t.hit.row
    const options = row.spec.options ?? {}
    const values = t.hit.node.node.values ?? {}
    const value = Object.prototype.hasOwnProperty.call(values, row.valueKey)
      ? values[row.valueKey]
      : effectiveWidgetDefault(row.spec)
    const schema = context.resolveSchema?.(t.hit.node.node.type)
    const input = schema?.items.find((item: any) => item.kind === 'input' && item.id === row.inputId)
    const detail = [
      ...['min', 'max', 'step'].filter((key) => options[key] !== undefined).map((key) => `${key}: ${options[key]}`),
      ...(input?.tooltip ? [input.tooltip] : []),
    ]
    const text = formatWidgetValue(t.companion?.value ?? value, row.spec)
    const state = t.companion?.state ?? (t.companion?.stale ? 'stale' : t.companion ? 'expected' : undefined)
    const line = state === 'expected'
      ? `Current expected value: ${text}`
      : state === 'cached'
        ? `Retained last-resolved value: ${text}`
        : state === 'stale'
          ? `Stale/unproven value: ${text}`
          : state === 'estimate'
            ? `Mirrored estimate (computed locally, not executed): ${text}`
            : t.connected
              ? `Dormant stored value under connection: ${text}`
              : `Value: ${text}`
    const stored = t.companion && t.connected
      ? [`Dormant stored value under connection: ${formatWidgetValue(value, row.spec)}`]
      : []
    return { title: row.label, lines: [line, ...stored], ...(opts.detailed && detail.length ? { detail } : {}) }
  }
  if (t.kind === 'header') {
    if (t.hit.node.node.region !== undefined) return regionContractTooltip(t.hit.node.node.region)
    const unrecognized = t.hit.node.unrecognized === true || t.hit.node.missingSchema === true
    const schema = context.resolveSchema?.(t.hit.node.node.type)
    const pack = schema?.pack ? context.resolvePack?.(schema.pack) : undefined
    const originalTitle = schema?.displayName ?? t.hit.node.node.type
    const renamed = renamedNodeHeaderOriginalTitle(target, context) !== undefined
    const detail = [
      ...(schema?.description ? [schema.description] : []),
      ...(schema?.pack ? [`Source pack: ${pack?.displayName ?? schema.pack}`] : []),
    ]
    if (unrecognized) detail.push('Schema unavailable')
    return {
      title: t.hit.node.layout.title,
      lines: unrecognized
        ? [`Unknown node type: ${t.hit.node.node.type}`]
        : [...(renamed ? [`Original: ${originalTitle}`] : [t.hit.node.node.type]), ...(schema?.hasDocs === true ? [translate('nodeHelp.tooltip.full')] : [])],
      ...(opts.detailed && detail.length ? { detail } : {}),
    }
  }
  return undefined
}

/** Event-delegated opt-in for chrome: data-tooltip-label plus optional data-tooltip-detail. */
export function attachDomTooltips(root: HTMLElement, controller: TooltipController): () => void {
  let sessionGrace: ReturnType<typeof setTimeout> | undefined
  let hovered: HTMLElement | undefined
  let shown: HTMLElement | undefined
  // Stateful controls rewrite data-tooltip-label from click handlers that run
  // after the focus-driven show has already captured the old text. Watching
  // the shown element's tooltip attributes keeps the visible tooltip current.
  // Removal never fires an attribute mutation, so the tree is watched too:
  // a tooltip must not outlive its control. Unrelated tree churn is cheap
  // here (the observer only runs while a tooltip is pending or visible) and
  // must not re-resolve the tooltip, so only attribute mutations refresh.
  const labelObserver = new MutationObserver((mutations) => {
    if (shown === undefined) return
    if (!shown.isConnected) { hideNow(); return }
    if (mutations.some((mutation) => mutation.type === 'attributes')) refreshShown()
  })
  const observeShown = (element: HTMLElement): void => {
    if (shown === element) return
    shown = element
    labelObserver.disconnect()
    labelObserver.observe(element, { attributes: true, attributeFilter: ['data-tooltip-label', 'data-tooltip-detail'] })
    labelObserver.observe(root, { childList: true, subtree: true })
  }
  const releaseShown = (): void => {
    shown = undefined
    labelObserver.disconnect()
  }
  const clearSessionGrace = (): void => {
    if (sessionGrace !== undefined) clearTimeout(sessionGrace)
    sessionGrace = undefined
  }
  const hideNow = (): void => {
    clearSessionGrace()
    releaseShown()
    controller.hide()
  }
  const hideAfterSessionGrace = (): void => {
    clearSessionGrace()
    if (controller.visible) {
      sessionGrace = setTimeout(() => {
        sessionGrace = undefined
        releaseShown()
        controller.hideMatching(isDomTooltipTarget)
      }, DOM_TOOLTIP_SESSION_GRACE_MS)
    } else {
      releaseShown()
      controller.hideMatching(isDomTooltipTarget)
    }
  }
  const tooltipTargetOf = (target: EventTarget | null) =>
    (target instanceof Element ? target : undefined)?.closest<HTMLElement>('[data-tooltip-label]')
  const elementAt = (event: Event) => tooltipTargetOf(event.target)
  const focusedElement = () => document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-tooltip-label]')
    ? document.activeElement
    : undefined
  const sessionOf = (element: Element | null | undefined) => element?.closest<HTMLElement>('[data-tooltip-session]')
  const domTargetOf = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const detail = element.dataset['tooltipDetail']?.split('|').filter(Boolean)
    return {
      target: { kind: 'dom', label: element.dataset['tooltipLabel']!, ...(detail ? { detail } : {}) },
      anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 8 },
    }
  }
  const showForElement = (element: HTMLElement, detailed?: boolean, immediate = false): void => {
    const { target, anchor } = domTargetOf(element)
    observeShown(element)
    controller.show(target, anchor, detailed, immediate)
  }
  const refreshShown = (): void => {
    const element = shown
    if (element === undefined) return
    if (!element.isConnected || element.dataset['tooltipLabel'] === undefined) { hideNow(); return }
    if (hovered !== element && document.activeElement !== element) return
    const { target, anchor } = domTargetOf(element)
    controller.showInSession(target, anchor)
  }
  const enter = (event: PointerEvent) => {
    const element = elementAt(event)
    if (!element || (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) return
    hovered = element
    clearSessionGrace()
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : undefined
    const session = sessionOf(element)
    const sharedSession = session !== undefined && session === sessionOf(related)
    if (sharedSession) {
      const { target, anchor } = domTargetOf(element)
      observeShown(element)
      controller.showInSession(target, anchor, event.altKey)
    } else showForElement(element, event.altKey)
  }
  const leave = (event: PointerEvent) => {
    const element = elementAt(event)
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : undefined
    if (!element) {
      const session = sessionOf(event.target instanceof Element ? event.target : undefined)
      if (session !== undefined && session !== sessionOf(related)) hideNow()
      return
    }
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return
    if (hovered === element) hovered = undefined
    if (document.activeElement === element) return
    const focused = focusedElement()
    if (focused !== undefined) { showForElement(focused, undefined, true); return }
    const session = sessionOf(element)
    if (session === undefined || session !== sessionOf(related)) hideNow()
    else if (!tooltipTargetOf(event.relatedTarget)) hideAfterSessionGrace()
  }
  const focusIn = (event: FocusEvent) => {
    const element = elementAt(event)
    if (element && event.target === element) { clearSessionGrace(); showForElement(element, undefined, true) }
  }
  const focusOut = (event: FocusEvent) => {
    const element = elementAt(event)
    if (!element || event.target !== element) return
    if (hovered !== undefined) showForElement(hovered, undefined, true)
    else hideNow()
  }
  const down = () => hideNow()
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Alt') controller.setDetailed(true); if (event.key === 'Escape') hideNow() }
  const keyup = (event: KeyboardEvent) => { if (event.key === 'Alt') controller.setDetailed(false) }
  root.addEventListener('pointerover', enter)
  root.addEventListener('pointerout', leave)
  root.addEventListener('focusin', focusIn)
  root.addEventListener('focusout', focusOut)
  root.addEventListener('pointerdown', down)
  window.addEventListener('keydown', keydown)
  window.addEventListener('keyup', keyup)
  return () => { clearSessionGrace(); releaseShown(); controller.hideMatching(isDomTooltipTarget); root.removeEventListener('pointerover', enter); root.removeEventListener('pointerout', leave); root.removeEventListener('focusin', focusIn); root.removeEventListener('focusout', focusOut); root.removeEventListener('pointerdown', down); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup) }
}
