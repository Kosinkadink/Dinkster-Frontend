import { createSignal, For, Show, type JSX } from 'solid-js'
import type { MenuActionItem, PreviewMode, ResolvedMenuGroup } from '@dinkster/core'
import { ProductRunIcon } from '@dinkster/ui'
import Workflow from 'lucide-solid/icons/workflow'
import PanelsTopLeft from 'lucide-solid/icons/panels-top-left'
import Spline from 'lucide-solid/icons/spline'
import Code from 'lucide-solid/icons/code'
import File from 'lucide-solid/icons/file'
import Plus from 'lucide-solid/icons/plus'
import X from 'lucide-solid/icons/x'
import { ContextMenu } from './ContextMenu.js'
import { Icon } from './Icon.js'
import { useAppMessage } from './locale.js'

export interface WorkflowTabItem {
  readonly id: string
  readonly title: string
  readonly editorKind?: string
}

export type TabRunState = 'idle' | 'queued' | 'running' | 'finished' | 'failed'

const kindIcon = (kind: string | undefined) => {
  switch (kind) {
    case undefined:
    case 'graph': return Workflow
    case 'app': return PanelsTopLeft
    case 'curve': return Spline
    case 'glsl': return Code
    default: return File
  }
}

export interface WorkflowTabsProps<T extends WorkflowTabItem> {
  readonly tabs: readonly T[]
  readonly activeId: string
  readonly draggedId?: string | undefined
  readonly insertionIndex?: number | undefined
  readonly runState?: ((tab: T) => TabRunState) | undefined
  readonly isDirty: (tab: T) => boolean
  readonly isFrozen: (tab: T) => boolean
  readonly isShared: (tab: T) => boolean
  readonly renderLeading?: (tab: T) => JSX.Element
  readonly setRoot: (root: HTMLElement) => void
  readonly onActivate: (event: MouseEvent, tab: T) => void
  readonly onClose: (tab: T) => void
  readonly onRename?: ((tab: T) => void) | undefined
  readonly onDuplicate?: ((tab: T) => void) | undefined
  readonly onCloseOthers?: ((tab: T) => void) | undefined
  readonly targets?: readonly { readonly id: string; readonly label: string }[] | undefined
  readonly targetId?: ((tab: T) => string) | undefined
  readonly onSetTarget?: ((tab: T, id: string) => void) | undefined
  readonly onPointerDown: (event: PointerEvent, tab: T) => void
  readonly onNew: () => void
  readonly canShare: (tab: T) => boolean
  readonly onShare: (tab: T) => void
  readonly onPopOut?: ((tab: T) => void) | undefined
  readonly showNew?: boolean | undefined
  /** DOM id of the editor panel this strip controls (aria-controls). */
  readonly panelId?: string | undefined
  /** Split the tab into a new group beside/below its current group. */
  readonly onSplitRight?: ((tab: T) => void) | undefined
  readonly onSplitDown?: ((tab: T) => void) | undefined
  /** Whether a split of this tab would be accepted (depth, single tab). */
  readonly canSplit?: ((tab: T) => boolean) | undefined
  /** Merge this strip's group into its neighbor; absent when sole group. */
  readonly onUnsplit?: (() => void) | undefined
  /** Workflow-wide live-preview override (undefined = inherit the global setting). */
  readonly previews?: ((tab: T) => PreviewMode | undefined) | undefined
  /** Set (or clear, with null) the workflow-wide live-preview override. */
  readonly onSetPreviews?: ((tab: T, mode: PreviewMode | null) => void) | undefined
}

const WORKFLOW_PREVIEW_MODES: readonly (PreviewMode | null)[] = [null, 'off', 'cheap', 'quality', 'auto']

export const workflowTabDomId = (id: string): string => `workflow-tab-${encodeURIComponent(id)}`

export function WorkflowTabs<T extends WorkflowTabItem>(props: WorkflowTabsProps<T>) {
  const message = useAppMessage()
  const [menu, setMenu] = createSignal<{ readonly tab: T; readonly x: number; readonly y: number }>()
  const menuGroups = (tab: T): readonly ResolvedMenuGroup[] => [
    {
      group: 'workflow-document',
      items: [
        { id: 'workflow.rename', label: message('shell.workflowTabs.rename'),
          action: { kind: 'host', action: 'workflow.rename' }, disabled: props.onRename === undefined },
        { id: 'workflow.duplicate', label: message('shell.workflowTabs.duplicate'),
          action: { kind: 'host', action: 'workflow.duplicate' }, disabled: props.onDuplicate === undefined },
      ],
    },
    ...(props.onSplitRight !== undefined || props.onSplitDown !== undefined || props.onUnsplit !== undefined
      ? [{
          group: 'workflow-split',
          items: [
            ...(props.onSplitRight !== undefined
              ? [{
                  id: 'workflow.splitRight',
                  label: message('shell.workflowTabs.splitRight'),
                  action: { kind: 'host', action: 'workflow.splitRight' },
                  ...(props.canSplit?.(tab) === false ? { disabled: true } : {}),
                } satisfies MenuActionItem]
              : []),
            ...(props.onSplitDown !== undefined
              ? [{
                  id: 'workflow.splitDown',
                  label: message('shell.workflowTabs.splitDown'),
                  action: { kind: 'host', action: 'workflow.splitDown' },
                  ...(props.canSplit?.(tab) === false ? { disabled: true } : {}),
                } satisfies MenuActionItem]
              : []),
            ...(props.onUnsplit !== undefined
              ? [{
                  id: 'workflow.unsplit',
                  label: message('shell.workflowTabs.unsplit'),
                  action: { kind: 'host', action: 'workflow.unsplit' },
                } satisfies MenuActionItem]
              : []),
          ],
        } satisfies ResolvedMenuGroup]
      : []),
    ...(props.onPopOut !== undefined
      ? [{
          group: 'workflow-placement',
          items: [{
            id: 'workflow.openWindow',
            label: message('shell.chrome.moveToNewWindow'),
            action: { kind: 'host', action: 'workflow.openWindow' },
          }],
        } satisfies ResolvedMenuGroup]
      : []),
    {
      group: 'workflow-share',
      items: [{
        id: 'workflow.share', label: message('shell.workflowTabs.share'),
        action: { kind: 'host', action: 'workflow.share' }, disabled: !props.canShare(tab),
      }],
    },
    ...(props.previews !== undefined && props.onSetPreviews !== undefined
      ? [{
          group: 'workflow-previews',
          items: [{
            id: 'workflow.previews',
            label: message('shell.workflowTabs.livePreviews'),
            ...(props.isFrozen(tab) ? { disabled: true } : {}),
            children: WORKFLOW_PREVIEW_MODES.map((mode) => ({
              id: `workflow.previews.${mode ?? 'inherit'}`,
              label: message(`shell.workflowTabs.preview.${mode ?? 'inheritGlobal'}`),
              checked: (props.previews!(tab) ?? null) === mode,
              action: { kind: 'host', action: 'workflow.setPreviews', params: { mode } },
            } satisfies MenuActionItem)),
          }],
        } satisfies ResolvedMenuGroup]
      : []),
    ...(props.targets !== undefined && props.onSetTarget !== undefined
      ? [{ group: 'workflow-target', items: [{
          id: 'workflow.target', label: message('shell.workflowTabs.queuesTo'), disabled: props.isFrozen(tab),
          children: props.targets.map((target) => ({
            id: `workflow.target.${target.id}`, label: target.label,
            checked: props.targetId?.(tab) === target.id,
            action: { kind: 'host', action: 'workflow.target', params: { id: target.id } },
          } satisfies MenuActionItem)),
        }] } satisfies ResolvedMenuGroup]
      : []),
    {
      group: 'workflow-close',
      items: [
        { id: 'workflow.close', label: message('shell.workflowTabs.closeMenu'),
          action: { kind: 'host', action: 'workflow.close' } },
        { id: 'workflow.closeOthers', label: message('shell.workflowTabs.closeOthers'),
          action: { kind: 'host', action: 'workflow.closeOthers' },
          disabled: props.onCloseOthers === undefined || props.tabs.length < 2 },
      ],
    },
  ]
  const focusTab = (tab: T): void => {
    document.getElementById(workflowTabDomId(tab.id))?.focus()
  }
  const invokeMenu = (tab: T, item: MenuActionItem): void => {
    setMenu(undefined)
    focusTab(tab)
    if (item.id === 'workflow.rename') props.onRename?.(tab)
    if (item.id === 'workflow.duplicate') props.onDuplicate?.(tab)
    if (item.id === 'workflow.close') props.onClose(tab)
    if (item.id === 'workflow.closeOthers') props.onCloseOthers?.(tab)
    if (item.id.startsWith('workflow.target.')) props.onSetTarget?.(tab, item.id.slice('workflow.target.'.length))
    if (item.id === 'workflow.share') props.onShare(tab)
    if (item.id.startsWith('workflow.previews.')) {
      const suffix = item.id.slice('workflow.previews.'.length)
      props.onSetPreviews?.(tab, suffix === 'inherit' ? null : suffix as PreviewMode)
    }
    if (item.id === 'workflow.openWindow') props.onPopOut?.(tab)
    if (item.id === 'workflow.splitRight') props.onSplitRight?.(tab)
    if (item.id === 'workflow.splitDown') props.onSplitDown?.(tab)
    if (item.id === 'workflow.unsplit') props.onUnsplit?.()
  }
  const label = (tab: T): string => [
    tab.title,
    props.runState?.(tab) === 'queued' ? message('executionLog.status.queued')
      : props.runState?.(tab) === 'running' ? message('executionLog.status.running')
      : props.runState?.(tab) === 'finished' ? message('executionLog.status.completed')
      : props.runState?.(tab) === 'failed' ? message('executionLog.status.error') : undefined,
    props.isDirty(tab) ? message('shell.workflowTabs.state.unsavedChanges') : undefined,
    props.isShared(tab) ? message('shell.workflowTabs.state.shared') : undefined,
    props.isFrozen(tab) ? message('shell.workflowTabs.state.executionSnapshot') : undefined,
  ].filter((value) => value !== undefined).join(', ')
  const focusAndActivate = (from: T, direction: -1 | 1 | 'first' | 'last'): void => {
    if (props.tabs.length === 0) return
    const current = props.tabs.findIndex((tab) => tab.id === from.id)
    const next = direction === 'first'
      ? props.tabs[0]
      : direction === 'last'
        ? props.tabs.at(-1)
        : props.tabs[(current + direction + props.tabs.length) % props.tabs.length]
    if (!next) return
    const trigger = document.getElementById(workflowTabDomId(next.id)) as HTMLButtonElement | null
    trigger?.focus()
    props.onActivate(new MouseEvent('click'), next)
  }
  const onTabKeyDown = (event: KeyboardEvent, tab: T): void => {
    const direction = event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowLeft'
        ? -1
        : event.key === 'Home'
          ? 'first'
          : event.key === 'End'
            ? 'last'
            : undefined
    if (direction !== undefined) {
      event.preventDefault()
      focusAndActivate(tab, direction)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      props.onClose(tab)
    }
  }
  return (
    <nav
      ref={(root) => props.setRoot(root)}
      classList={{ 'workflow-tabs': true, 'tab-dragging': props.draggedId !== undefined }}
      data-testid="tab-bar"
      aria-label={message('shell.workflowTabs.documents')}
    >
      {/* Keep close/new buttons outside the tablist without changing visual scroll order. */}
      <div class="visually-hidden" role="tablist" aria-label={message('shell.workflowTabs.openWorkflows')}
        aria-owns={props.tabs.map((tab) => workflowTabDomId(tab.id)).join(' ')} />
      <div class="workflow-tablist">
        <For each={props.tabs}>{(tab) => (
          <div
            classList={{
              tab: true,
              active: tab.id === props.activeId,
              frozen: props.isFrozen(tab),
              shared: props.isShared(tab),
              dragging: props.draggedId === tab.id,
            }}
            data-tab-id={tab.id}
            data-drop-index={props.draggedId === tab.id ? props.insertionIndex : undefined}
            onPointerDown={(event) => props.onPointerDown(event, tab)}
            onContextMenu={(event) => {
              event.preventDefault()
              props.onActivate(event, tab)
              if (event.clientX === 0 && event.clientY === 0) {
                // Keyboard-initiated menu (ContextMenu key / Shift+F10): anchor to the tab.
                const rect = document.getElementById(workflowTabDomId(tab.id))?.getBoundingClientRect()
                setMenu({ tab, x: (rect?.left ?? 0) + 8, y: (rect?.bottom ?? 0) - 2 })
                return
              }
              setMenu({ tab, x: event.clientX, y: event.clientY })
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              props.onClose(tab)
            }}
          >
            {props.renderLeading?.(tab)}
            <button
              id={workflowTabDomId(tab.id)}
              class="tab-select"
              role="tab"
              data-tooltip-label={tab.title}
              aria-label={label(tab)}
              aria-selected={tab.id === props.activeId}
              aria-controls={props.panelId ?? 'workflow-editor-panel'}
              tabindex={tab.id === props.activeId ? 0 : -1}
              onClick={(event) => props.onActivate(event, tab)}
              onKeyDown={(event) => onTabKeyDown(event, tab)}
            >
              <ProductRunIcon
                icon={kindIcon(tab.editorKind)}
                running={props.runState?.(tab) === 'running'}
                queued={props.runState?.(tab) === 'queued'}
                result={props.runState?.(tab) === 'finished' ? 'finished' : props.runState?.(tab) === 'failed' ? 'failed' : undefined}
              />
              <span class="tab-title">{tab.title}</span>
            </button>
            <span classList={{
              'tab-affordance': true,
              dirty: props.isDirty(tab),
            }}>
              <Show when={props.isDirty(tab)}><span class="tab-dirty" aria-hidden="true" /></Show>
              <button
                class="tab-close"
                data-testid="tab-close"
                aria-label={message('shell.workflowTabs.close', { title: tab.title })}
                tabindex={tab.id === props.activeId ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(tab)
                }}
              >
                <Icon icon={X} />
              </button>
            </span>
          </div>
        )}</For>
        <Show when={props.showNew !== false}><button
          class="tab-new"
          data-testid="new-tab"
          data-tooltip-label={message('shell.workflow.new')}
          aria-label={message('shell.workflow.new')}
          onClick={props.onNew}
        >
          <Icon icon={Plus} />
        </button></Show>
      </div>
      <Show when={menu()} keyed>{(current) => (
        <ContextMenu
          menu={{ x: current.x, y: current.y, worldX: 0, worldY: 0, get groups() { return menuGroups(current.tab) } }}
          onInvoke={(item) => invokeMenu(current.tab, item)}
          onClose={(reason) => {
            setMenu(undefined)
            if (reason === 'escape') focusTab(current.tab)
          }}
        />
      )}</Show>
    </nav>
  )
}
