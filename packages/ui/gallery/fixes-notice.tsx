import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  defaultTokens,
  createRegistryPainter,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import { createNodeLookFixture } from '../../canvas/gallery/fixtures.js'
import {
  ProductButton,
  ProductFixesCount,
  ProductFixesNotice,
  ProductSection,
  fixesNoticeCount,
  type FixesNoticeChange,
  type FixesNoticeState,
  type FixesNoticeStrings,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH } from './row-editing.js'

const plural = (count: number, one: string, other: string) =>
  `${count} ${count === 1 ? one : other}`

const kinds: Record<string, string> = {
  outputs: 'Outputs matched to their lists',
  wires: 'Wires kept, now empty',
  limits: 'Numbers corrected to limits',
  replaced: 'Nodes replaced by newer ones',
  removedChoice: 'Removed choices replaced',
}

const strings: FixesNoticeStrings = {
  adjusted: (count) => `${plural(count, 'thing was', 'things were')} adjusted`,
  undone: 'Adjustments undone',
  review: 'Review',
  undo: 'Undo',
  redo: 'Redo adjustments',
  dismiss: 'Dismiss',
  refused: 'Someone else has since changed one of the adjusted values.',
  heading: 'Adjusted in this workflow',
  summary: (changes, nodes) =>
    `${plural(changes, 'adjustment', 'adjustments')} across ${plural(nodes, 'node', 'nodes')}`,
  group: (kind, count) => `${kinds[kind] ?? kind} (${count})`,
  settings: 'Automatic fixes...',
}

const change = (
  id: string,
  kind: string,
  target: string,
  node: string,
  text: string,
  count = 1,
): FixesNoticeChange => ({ id, kind, target, node, text, count })

const twelve: readonly FixesNoticeChange[] = [
  change(
    'frames',
    'outputs',
    'frames',
    'Unpack frames',
    'Outputs 5-13 added. Existing outputs and wires were kept.',
    9,
  ),
  change(
    'masks',
    'wires',
    'masks',
    'Unpack masks',
    'Outputs 4 and 5 kept. Their wires carry nothing.',
    2,
  ),
  change('steps', 'limits', 'sampler', 'Sampler', 'steps: 12000 to 10000'),
]

const four: readonly FixesNoticeChange[] = [
  change('steps', 'limits', 'sampler', 'Sampler', 'steps: 12000 to 10000'),
  change('cfg', 'limits', 'sampler', 'Sampler', 'cfg: -2 to 0'),
  change('frames', 'outputs', 'frames', 'Unpack frames', 'Output 4 added.'),
  change('resize', 'replaced', 'resize', 'Resize image', 'replaced older node'),
]

/** The two kinds the editor reports first: node replacement and replaced removed choices. */
const firstKinds: readonly FixesNoticeChange[] = [
  ...[
    'Load image',
    'Resize image',
    'Sampler',
    'Upscale image',
    'Save image',
  ].map((node, index) =>
    change(`r${index}`, 'replaced', `r${index}`, node, 'replaced older node'),
  ),
  change(
    'c0',
    'removedChoice',
    'c0',
    'Sampler',
    'sampler_name: dpm_fast was removed; euler is used',
  ),
  change(
    'c1',
    'removedChoice',
    'c1',
    'Video combine',
    'format: gif was removed; webp is used',
  ),
  ...['Mask', 'Crop', 'Blend', 'Sharpen'].map((node, index) =>
    change(
      `c${index + 2}`,
      'removedChoice',
      `c${index + 2}`,
      node,
      'mode: legacy was removed; standard is used',
    ),
  ),
]

const arriving: readonly FixesNoticeChange[] = [
  change('scale', 'limits', 'upscale', 'Upscale image', 'scale: 16 to 8'),
]

interface NoticeCard {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly changes: readonly FixesNoticeChange[]
  readonly state?: FixesNoticeState
  readonly review?: boolean
  /** Shown after the notice was dismissed: only the status bar count. */
  readonly dismissed?: boolean
  /** Nothing to report: no notice and no count. */
  readonly none?: boolean
  /** Adds a change while the card is open, as one arriving during Review. */
  readonly arrives?: readonly FixesNoticeChange[]
  /** The notice's words after Undo, when they differ from the plain "Adjustments undone". */
  readonly undoneText?: string
  /** `wide`: room for open Review beside the node; `node`: only as tall as the node. */
  readonly stage?: 'wide' | 'node'
}

const cards: readonly NoticeCard[] = [
  {
    id: 'grouped',
    title: 'More than ten changes',
    description:
      'Opening a workflow that needed 12 changes shows one quiet line in the bottom right corner of the canvas. Review groups the changes by kind, each kind with its count; under a kind each node appears once. Choosing a row asks the canvas to go to that node. Undo takes back all 12 in one step; the cross dismisses the notice and Escape closes only Review.',
    changes: twelve,
    review: true,
    stage: 'wide',
  },
  {
    id: 'per-node',
    title: 'Ten changes or fewer',
    description:
      'One row per node with every change to that node on its row. The count is of changes (4), not of nodes (3). A replaced node is reported here too.',
    changes: four,
    review: true,
  },
  {
    id: 'arriving',
    title: 'A change arriving while Review is open',
    description:
      'Choose a row, then add the change: it is added under its kind, the chosen row stays chosen, the list does not close or jump, and the count goes from 12 to 13.',
    changes: twelve,
    review: true,
    arrives: arriving,
    stage: 'wide',
  },
  {
    id: 'first-kinds',
    title: 'The kinds this editor reports first',
    description:
      'The other examples use kinds that later fixes bring. Today the editor reports two: nodes replaced by newer ones, and removed choices replaced by the option the node now uses. Eleven changes, so Review groups them.',
    changes: firstKinds,
    review: true,
    stage: 'wide',
  },
  {
    id: 'none',
    title: 'Nothing adjusted',
    description:
      'A workflow that needed no changes shows no notice on the canvas and no count in the status bar.',
    changes: [],
    none: true,
    stage: 'node',
  },
  {
    id: 'dismissed',
    title: 'After the notice is dismissed',
    description:
      'The count stays in the status bar until the workflow is saved or closed. Choosing it brings the notice back with Review open, and this example grows to show it. Each open workflow has its own notice and count.',
    changes: twelve,
    dismissed: true,
    stage: 'wide',
  },
  {
    id: 'undone',
    title: 'After Undo',
    description:
      'Undo put every old value back in one step. Redo adjustments puts back the changes as they were recorded; it does not work them out again.',
    changes: twelve,
    state: 'undone',
  },
  {
    id: 'undone-kept',
    title: 'After Undo, with your own edit kept',
    description:
      'You changed one of the adjusted values after the editor made it. Undo put back every other adjustment and left that one as you edited it, and the notice says how many it kept. Each adjustment is kept or put back whole: a replaced node with its values and wires, or one removed choice. Redo adjustments puts back only what Undo took back.',
    changes: twelve,
    state: 'undone',
    undoneText: 'Adjustments undone. 1 was kept because you changed it since.',
  },
  {
    id: 'refused',
    title: 'Undo refused',
    description:
      'Another person changed one of the adjusted values after the editor made it. Undo is off for the whole notice, which says why; their value is never overwritten. Review still works.',
    changes: twelve,
    state: 'refused',
  },
  {
    id: 'saved',
    title: 'After saving or closing',
    description:
      'Saving or closing clears the notice and the count. The changed values are what was saved, and problems that are still true stay in Problems.',
    changes: [],
    none: true,
    stage: 'node',
  },
]

/** Room for the node and for Review opening above the notice line. */
const STAGE_WIDTH = 640
const STAGE_HEIGHT = 460
/** Review's width, the fixesReviewWidth component token. */
const REVIEW_WIDTH = 360
/** The node, then Review beside it, so the open list never covers the node. */
const WIDE_STAGE_WIDTH =
  MARGIN * 2 + NODE_WIDTH + MARGIN + REVIEW_WIDTH + MARGIN

function NodeCanvas(props: {
  theme: 'dark' | 'light'
  registry: WidgetRegistry
  id: string
  stage?: 'wide' | 'node' | undefined
}) {
  let canvas!: HTMLCanvasElement
  createEffect(() => {
    const theme = props.theme
    const stage = props.stage
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void Promise.all([
      document.fonts.load(
        `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
    ]).then(() => {
      if (disposed) return
      const tokens: DesignTokens = {
        ...defaultTokens,
        ...canvasTypePaintForTheme(theme),
        colors: canvasColorsForTheme(theme),
      }
      const measureContext = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return measureContext.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.registry.kind(spec.widgetType)
        const view = props.registry
          .viewsFor(spec.widgetType)
          .find((view) => view.id === kind?.defaultView(spec))
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      const fixture = createNodeLookFixture(
        'sample',
        tokens,
        measure,
        widgetMeasure,
        { x: MARGIN * 2, y: MARGIN * 2 },
        NODE_WIDTH,
      )
      const node = fixture.scene.nodes[0]!
      canvas.style.width = `${stage === 'wide' ? WIDE_STAGE_WIDTH : STAGE_WIDTH}px`
      canvas.style.height = `${stage === 'node' ? node.y + node.layout.height + MARGIN * 2 : STAGE_HEIGHT}px`
      renderer = new CanvasRenderer(
        canvas,
        tokens,
        createRegistryPainter(props.registry),
      )
      renderer.setReducedMotion(true)
      renderer.setScene(fixture.scene)
      renderer.setNodeStates(fixture.states)
      renderer.setBadges(fixture.badges)
      renderer.setOverlay(fixture.overlay)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.renderNow()
      canvas.dataset.ready = `${props.id}-${theme}`
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={`Canvas with Sample image in ${props.theme} theme`}
    />
  )
}

function NoticeExample(props: {
  card: NoticeCard
  theme: 'dark' | 'light'
  registry: WidgetRegistry
}) {
  const [changes, setChanges] = createSignal(props.card.changes)
  const [state, setState] = createSignal<FixesNoticeState>(
    props.card.state ?? 'ready',
  )
  const [shown, setShown] = createSignal(
    !props.card.none && !props.card.dismissed,
  )
  const [reopened, setReopened] = createSignal(false)
  const [chosen, setChosen] = createSignal('')
  const counted = () => (props.card.none ? 0 : fixesNoticeCount(changes()))
  return (
    <ProductSection
      title={props.card.title}
      description={props.card.description}
    >
      <div class="dinkster-canvas-examples">
        <figure
          class="dinkster-canvas-example"
          data-testid={`fixes-notice-${props.card.id}`}
        >
          <div class="dinkster-canvas-example-stage">
            <NodeCanvas
              theme={props.theme}
              registry={props.registry}
              id={props.card.id}
              stage={
                props.card.dismissed && !shown() ? 'node' : props.card.stage
              }
            />
            <div class="dinkster-fixes-example-corner">
              <Show when={shown()} keyed>
                {(_) => (
                  <ProductFixesNotice
                    changes={changes()}
                    state={state()}
                    strings={
                      props.card.undoneText === undefined
                        ? strings
                        : { ...strings, undone: props.card.undoneText }
                    }
                    reviewOpen={props.card.review === true || reopened()}
                    onChoose={(target) => setChosen(target)}
                    onUndo={() => setState('undone')}
                    onRedo={() => setState('ready')}
                    onDismiss={() => setShown(false)}
                    onSettings={() => setChosen('settings')}
                  />
                )}
              </Show>
            </div>
          </div>
          <div class="dinkster-fixes-example-status">
            <span>Connected</span>
            <Show when={!shown() && counted() > 0 && state() !== 'undone'}>
              <ProductFixesCount
                count={counted()}
                label={`${counted()} adjusted`}
                onOpen={() => {
                  setReopened(true)
                  setShown(true)
                }}
              />
            </Show>
          </div>
          <figcaption class="dinkster-metadata">
            <Show when={chosen()} fallback="Nothing chosen yet.">
              {(target) =>
                target() === 'settings'
                  ? 'Opens the settings of automatic fixes.'
                  : `Moves the canvas to ${changes().find((change) => change.target === target())?.node}.`
              }
            </Show>
          </figcaption>
          <Show when={props.card.arrives}>
            {(extra) => (
              <div class="dinkster-actions">
                <ProductButton
                  disabled={changes().length !== props.card.changes.length}
                  onClick={() => setChanges([...changes(), ...extra()])}
                >
                  Add a change
                </ProductButton>
              </div>
            )}
          </Show>
        </figure>
      </div>
    </ProductSection>
  )
}

/** The notice that reports the small fixes the editor makes by itself, in each of its states. */
export function FixesNoticeGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <For each={cards}>
      {(card) => (
        <NoticeExample card={card} theme={props.theme} registry={registry} />
      )}
    </For>
  )
}
