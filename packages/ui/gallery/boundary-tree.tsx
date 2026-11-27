import { Show, createSignal, type JSX } from 'solid-js'
import { Plus, Trash2, TriangleAlert } from 'lucide-solid'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import {
  BoundaryTree,
  ProductButton,
  ProductCheckbox,
  ProductIcon,
  ProductLink,
  ProductTextInput,
  type BoundaryTreeDrag,
  type BoundaryTreeDrop,
  type BoundaryTreeEntry,
  type BoundaryTreeRow,
} from '../src/index.js'

const color = (type: string) => typeColor(defaultTokens, type)
const input = (
  id: string,
  label: string,
  type: string,
  target: string,
  extra: Partial<BoundaryTreeRow> = {},
): BoundaryTreeRow => ({
  kind: 'row',
  id,
  side: 'input',
  label,
  color: color(type),
  target,
  ...extra,
})
const output = (
  id: string,
  label: string,
  type: string,
  target: string,
): BoundaryTreeRow => ({
  kind: 'row',
  id,
  side: 'output',
  label,
  color: color(type),
  target,
})

/** The boundary of "Detail pass": every kind of entry the tree holds. */
const detailPass = (
  options: { advancedOpen?: boolean; lookOpen?: boolean } = {},
): readonly BoundaryTreeEntry[] => [
  input('image', 'image', 'IMAGE', 'Blend'),
  input('mask', 'mask', 'MASK', 'Blend'),
  output('result', 'result', 'IMAGE', 'Blend'),
  {
    kind: 'section',
    id: 'look',
    label: 'Look',
    open: options.lookOpen ?? true,
    rows: [
      {
        kind: 'line',
        id: 'line-radius',
        rows: [
          input('radius', 'radius', 'FLOAT', 'Blur'),
          input('strength', 'strength', 'FLOAT', 'Blend', { condition: true }),
          input('feather', 'feather', 'INT', 'Edge'),
        ],
      },
      input('mode', 'mode', 'COMBO', 'Blend'),
      {
        kind: 'section',
        id: 'advanced',
        label: 'Advanced',
        open: options.advancedOpen ?? false,
        rows: [
          input('grain', 'grain', 'FLOAT', 'Grain'),
          input('seed', 'seed', 'INT', 'Grain'),
        ],
      },
    ],
  },
  {
    kind: 'construct',
    id: 'images',
    construct: 'group',
    side: 'input',
    label: 'Images',
    target: 'Stack',
    note: 'growing group',
    template: [
      { label: 'image', side: 'input', color: color('IMAGE') },
      { label: 'strength', side: 'input', color: color('FLOAT') },
      { label: 'image out', side: 'output', color: color('IMAGE') },
    ],
  },
  {
    kind: 'construct',
    id: 'style',
    construct: 'choice',
    side: 'input',
    label: 'Style',
    target: 'Stylize',
    note: 'choice',
    template: [
      { label: 'image: image, strength', side: 'input', color: color('IMAGE') },
      { label: 'text: words, strength', side: 'input', color: color('STRING') },
    ],
  },
  {
    kind: 'construct',
    id: 'parts',
    construct: 'group',
    side: 'output',
    label: 'Parts',
    target: 'Split',
    note: 'counted by split count',
    template: [{ label: 'part', side: 'output', color: color('INT') }],
  },
  output('preview', 'preview', 'IMAGE', 'Blend'),
]

function Setting(props: { label: string; children: JSX.Element }) {
  return (
    <div class="boundary-tree-setting">
      <span class="boundary-tree-setting-label">{props.label}</span>
      <div class="boundary-tree-setting-value">{props.children}</div>
    </div>
  )
}

/** The slot where an entry sits now; a field of a line sits just after its line. */
function placeOf(
  entries: readonly BoundaryTreeEntry[],
  id: string,
  section?: string,
): BoundaryTreeDrop | undefined {
  for (const [index, entry] of entries.entries()) {
    if (entry.id === id) return { kind: 'slot', ...(section !== undefined ? { section } : {}), index }
    if (entry.kind === 'line' && entry.rows.some((row) => row.id === id))
      return { kind: 'slot', ...(section !== undefined ? { section } : {}), index: index + 1 }
    if (entry.kind === 'section') {
      const found = placeOf(entry.rows, id, entry.id)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function Panel(props: {
  title: string
  uses: string
  entries: readonly BoundaryTreeEntry[]
  selected?: string
  drag?: BoundaryTreeDrag
  heading?: string
  settings?: JSX.Element
  children?: JSX.Element
}) {
  const [entries, setEntries] = createSignal(props.entries)
  const [selected, setSelected] = createSignal(props.selected)
  // A row picked up by its body lifts into an empty slot at its place until
  // the press ends; the product panel moves the slot with the pointer.
  const [lifted, setLifted] = createSignal<BoundaryTreeDrag>()
  const pickUp = (id: string) => {
    const drop = placeOf(entries(), id)
    if (drop === undefined) return
    setLifted({ id, drop })
    window.addEventListener('pointerup', () => setLifted(undefined), { once: true })
  }
  const toggle = (id: string) => {
    const flip = (
      list: readonly BoundaryTreeEntry[],
    ): readonly BoundaryTreeEntry[] =>
      list.map((entry) =>
        entry.kind !== 'section'
          ? entry
          : entry.id === id
            ? { ...entry, open: !entry.open }
            : { ...entry, rows: flip(entry.rows) },
      )
    setEntries(flip(entries()))
  }
  return (
    <div class="boundary-tree-panel">
      <div class="boundary-tree-panel-head">
        <span class="boundary-tree-panel-title">{props.title}</span>
        <span class="boundary-tree-quiet">{props.uses}</span>
      </div>
      <span class="boundary-tree-panel-heading">{props.heading ?? 'Rows'}</span>
      <Show when={entries().length > 0} fallback={props.children}>
        <BoundaryTree
          entries={entries()}
          selected={selected()}
          drag={lifted() ?? props.drag}
          onSelect={setSelected}
          onDragStart={pickUp}
          onToggle={toggle}
        />
        {props.children}
      </Show>
      <Show when={props.settings}>
        <div class="boundary-tree-settings">{props.settings}</div>
      </Show>
    </div>
  )
}

function Example(props: {
  caption: string
  note: string
  children: JSX.Element
}) {
  return (
    <figure class="boundary-tree-example">
      {props.children}
      <figcaption>
        <strong>{props.caption}</strong>
        <span>{props.note}</span>
      </figcaption>
    </figure>
  )
}

const fieldSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">strength</span>
      <span class="boundary-tree-quiet">field</span>
    </div>
    <Setting label="Label">
      <ProductTextInput density="panel" value="strength" aria-label="Label" />
    </Setting>
    <Setting label="Goes to">
      <ProductLink href="#canvas">strength on Blend</ProductLink>
    </Setting>
    <Setting label="Default">
      <ProductTextInput density="panel" value="0.45" aria-label="Default" />
    </Setting>
  </>
)

const outputSettings = (forced: boolean) => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">preview</span>
      <span class="boundary-tree-quiet">output</span>
    </div>
    <Setting label="Label">
      <ProductTextInput density="panel" value="preview" aria-label="Label" />
    </Setting>
    <Setting label="From">
      <ProductLink href="#canvas">preview on Blend</ProductLink>
    </Setting>
    <ProductCheckbox label="Force its own row on the node" checked={forced} />
  </>
)

const sectionSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">Look</span>
      <span class="boundary-tree-quiet">section</span>
    </div>
    <Setting label="Name">
      <ProductTextInput density="panel" value="Look" aria-label="Name" />
    </Setting>
    <ProductCheckbox label="Show the name while open" checked />
    <ProductCheckbox label="Start closed on new nodes" />
    <div class="dinkster-actions boundary-tree-actions">
      <span class="boundary-tree-quiet">Keeps its rows.</span>
      <ProductButton density="panel" intent="remove">
        <ProductIcon icon={Trash2} />
        Remove section
      </ProductButton>
    </div>
  </>
)

const groupSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">Images</span>
      <span class="boundary-tree-quiet">group</span>
    </div>
    <Setting label="Label">
      <ProductTextInput density="panel" value="Images" aria-label="Label" />
    </Setting>
    <Setting label="Goes to">
      <ProductLink href="#canvas">images on Stack</ProductLink>
    </Setting>
  </>
)

const problemSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">detail</span>
      <span class="boundary-tree-quiet">field</span>
    </div>
    <div class="boundary-tree-problem" role="alert">
      <ProductIcon icon={TriangleAlert} />
      <span>Removed from "Detail pass".</span>
    </div>
    <div class="dinkster-actions boundary-tree-actions">
      <ProductButton density="panel" intent="remove">
        <ProductIcon icon={Trash2} />
        Remove row
      </ProductButton>
    </div>
  </>
)

const lineDrag: BoundaryTreeDrag = {
  id: 'grain',
  drop: { kind: 'pocket', line: 'line-radius' },
}

/** The Boundary panel's ordered tree, drawn by the component the panel uses. */
export function BoundaryTreeGallery() {
  return (
    <div class="boundary-tree-examples">
      <Example
        caption="One ordered tree, a field on a shared line selected"
        note="Rows, sections, lines of fields and whole constructs in the order the subgraph node draws them. An output keeps its own line, with its label at the right end; every grip is at the left."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass()}
          selected="strength"
          settings={fieldSettings()}
        />
      </Example>
      <Example
        caption="An output with Force its own row"
        note="Force its own row on the node keeps preview off the line of the pin above it."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ lookOpen: false })}
          selected="preview"
          settings={outputSettings(true)}
        />
      </Example>
      <Example
        caption="A section selected"
        note="A section is the only box made here. Removing it keeps its rows where it was."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ advancedOpen: true })}
          selected="look"
          settings={sectionSettings()}
        />
      </Example>
      <Example
        caption="A whole group selected"
        note="Its template, not every member: each subgraph node owns its members, after the definition's own."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ lookOpen: false })}
          selected="images"
          settings={groupSettings()}
        />
      </Example>
      <Example
        caption="Moving a row"
        note="mask lifts out and the rows open an empty slot where it would land. Escape puts it back."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass()}
          drag={{
            id: 'mask',
            drop: { kind: 'slot', section: 'look', index: 1 },
          }}
        />
      </Example>
      <Example
        caption="Moving a group"
        note="Style lifts out whole, with its lines, and the rows open a slot as tall as it where it would land."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ lookOpen: false })}
          drag={{ id: 'style', drop: { kind: 'slot', index: 4 } }}
        />
      </Example>
      <Example
        caption="Boxes inside a section"
        note="A choice and a section inside Finish take the same 16 px step as its rows. Only a section has an outline; a group or choice is one face."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={[
            input('image', 'image', 'IMAGE', 'Blend'),
            {
              kind: 'section',
              id: 'finish',
              label: 'Finish',
              open: true,
              rows: [
                input('grain', 'grain', 'FLOAT', 'Grain'),
                detailPass().find((entry) => entry.id === 'style')!,
                {
                  kind: 'section',
                  id: 'detail',
                  label: 'Detail',
                  open: true,
                  rows: [
                    input('seed', 'seed', 'INT', 'Grain'),
                    input('sharpen', 'sharpen', 'FLOAT', 'Sharpen'),
                  ],
                },
              ],
            },
            output('result', 'result', 'IMAGE', 'Blend'),
          ]}
        />
      </Example>
      <Example
        caption="Joining a line"
        note="A field dragged to the right end of a line with room shows in a pocket there. Outputs, full lines and rows of a group or choice have no pocket."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ advancedOpen: true })}
          drag={lineDrag}
        />
      </Example>
      <Example
        caption="Taking a field out of its line"
        note="Dragging feather by its name up or down takes it out of the line, into a slot of its own; from the keyboard, Alt with the up or down arrow does the same."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass()}
          drag={{
            id: 'feather',
            drop: { kind: 'slot', section: 'look', index: 2 },
          }}
        />
      </Example>
      <Example
        caption="An input added to a face that ends with a section and an output"
        note="steps was just shown on the subgraph node. A new input goes at the end of the top level, after a box that follows the last input and before the outputs that end the list; nothing goes inside a box by itself."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={[
            input('image', 'image', 'IMAGE', 'Blend'),
            input('mask', 'mask', 'MASK', 'Blend'),
            {
              kind: 'section',
              id: 'look',
              label: 'Look',
              open: false,
              rows: [
                input('radius', 'radius', 'FLOAT', 'Blur'),
                input('strength', 'strength', 'FLOAT', 'Blend'),
              ],
            },
            input('steps', 'steps', 'INT', 'Sampler'),
            output('result', 'result', 'IMAGE', 'Blend'),
          ]}
          selected="steps"
        />
      </Example>
      <Example
        caption="An output added after a pin-only input"
        note="preview was just shown; a new output goes at the very end. On the subgraph node it shares the line of mask, the pin-only input directly above it."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={[
            input('image', 'image', 'IMAGE', 'Blend'),
            input('strength', 'strength', 'FLOAT', 'Blend'),
            input('mask', 'mask', 'MASK', 'Blend'),
            output('preview', 'preview', 'IMAGE', 'Blend'),
          ]}
          selected="preview"
          settings={outputSettings(false)}
        />
      </Example>
      <Example
        caption="A section with no name while open"
        note="The open box keeps only the tab that closes it; closed, it shows its name."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={[
            input('image', 'image', 'IMAGE', 'Blend'),
            {
              kind: 'section',
              id: 'unnamed',
              label: 'Tuning',
              open: true,
              nameWhileOpen: false,
              rows: [
                input('radius', 'radius', 'FLOAT', 'Blur'),
                {
                  kind: 'section',
                  id: 'inner',
                  label: 'Grain',
                  open: true,
                  rows: [input('grain', 'grain', 'FLOAT', 'Grain')],
                },
              ],
            },
            {
              kind: 'section',
              id: 'closed',
              label: 'Tuning',
              open: false,
              nameWhileOpen: false,
              rows: [input('radius2', 'radius', 'FLOAT', 'Blur')],
            },
            output('result', 'result', 'IMAGE', 'Blend'),
          ]}
        />
      </Example>
      <Example
        caption="A row whose middle hop was removed"
        note="It keeps its place, inert, and says why."
      >
        <Panel
          title="Portrait fix"
          uses="used in 1 place"
          entries={[
            input('image', 'image', 'IMAGE', 'Detail pass'),
            input('detail', 'detail', 'FLOAT', 'Detail pass', {
              problem: 'Removed from Detail pass',
            }),
            output('result', 'result', 'IMAGE', 'Detail pass'),
          ]}
          selected="detail"
          settings={problemSettings()}
        />
      </Example>
      <Example
        caption="Nothing on the subgraph node yet"
        note="Rows come from inside the subgraph. The only box made here is a section."
      >
        <Panel title="Detail pass" uses="used in 1 place" entries={[]}>
          <div class="boundary-tree-empty">
            <span>
              No rows yet. Right-click a field inside and choose Show on
              subgraph node.
            </span>
            <div class="dinkster-actions boundary-tree-actions">
              <ProductButton density="panel" intent="add">
                <ProductIcon icon={Plus} />
                Add section
              </ProductButton>
            </div>
          </div>
        </Panel>
      </Example>
    </div>
  )
}
