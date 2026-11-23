import { Show, createSignal, type JSX } from 'solid-js'
import { TriangleAlert } from 'lucide-solid'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import {
  BoundaryTree,
  ProductButton,
  ProductCheckbox,
  ProductIcon,
  ProductLink,
  ProductTextInput,
  type BoundaryTreeDrag,
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
    color: color('IMAGE'),
    target: 'Stack',
    note: 'growing group',
    interior: '2 members inside the definition come first',
    templateLabel: 'Each member',
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
    color: color('COMBO'),
    target: 'Stylize',
    note: 'choice',
    templateLabel: 'Options',
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
    color: color('INT'),
    target: 'Split',
    note: 'counted by split count',
    templateLabel: 'Each member',
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
          drag={props.drag}
          onSelect={setSelected}
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
      <span class="boundary-tree-quiet">
        field, on a line with radius and feather
      </span>
    </div>
    <Setting label="Label">
      <ProductTextInput value="strength" aria-label="Label" />
    </Setting>
    <Setting label="Goes to">
      <ProductLink href="#canvas">strength on Blend</ProductLink>
    </Setting>
    <Setting label="Default">
      <ProductTextInput value="0.45" aria-label="Default" />
    </Setting>
    <Setting label="Line">
      <span>3 of 4 fields</span>
      <ProductButton>Put on a line of its own</ProductButton>
    </Setting>
  </>
)

const outputSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">preview</span>
      <span class="boundary-tree-quiet">output</span>
    </div>
    <Setting label="Label">
      <ProductTextInput value="preview" aria-label="Label" />
    </Setting>
    <Setting label="From">
      <ProductLink href="#canvas">preview on Blend</ProductLink>
    </Setting>
    <Setting label="On the node">
      <ProductCheckbox label="A line of its own" checked />
    </Setting>
    <span class="boundary-tree-quiet">
      Otherwise it shares the line of the pin just above it.
    </span>
  </>
)

const sectionSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">Look</span>
      <span class="boundary-tree-quiet">section, 6 rows</span>
    </div>
    <Setting label="Name">
      <ProductTextInput value="Look" aria-label="Name" />
    </Setting>
    <Setting label="Open">
      <ProductCheckbox label="Show the name" checked />
    </Setting>
    <Setting label="New nodes">
      <ProductCheckbox label="Start closed" />
    </Setting>
    <ProductButton intent="remove">Remove section</ProductButton>
    <span class="boundary-tree-quiet">
      Its rows stay, in the section's place.
    </span>
  </>
)

const groupSettings = () => (
  <>
    <div class="boundary-tree-settings-head">
      <span class="boundary-tree-panel-title">Images</span>
      <span class="boundary-tree-quiet">whole group</span>
    </div>
    <Setting label="Label">
      <ProductTextInput value="Images" aria-label="Label" />
    </Setting>
    <Setting label="Goes to">
      <ProductLink href="#canvas">images on Stack</ProductLink>
    </Setting>
    <Setting label="Members">
      <span>
        The 2 members inside the definition come first on every subgraph node;
        each node adds its own after them.
      </span>
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
      <span>
        Its row inside "Detail pass" was removed, so it sends nothing. The other
        rows still work.
      </span>
    </div>
    <ProductButton intent="remove">Remove row</ProductButton>
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
        note="Rows, sections, lines of fields and whole constructs in the order the subgraph node draws them. An output keeps its own line, with its label and grip at the right end."
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
        caption="An output kept on a line of its own"
        note="preview would otherwise share the line of the pin above it on the node; here it is kept apart."
      >
        <Panel
          title="Detail pass"
          uses="used in 2 places"
          entries={detailPass({ lookOpen: false })}
          selected="preview"
          settings={outputSettings()}
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
        note="Dragging feather by its name up or down takes it out of the line, into a slot of its own."
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
        note="It keeps its place, inert, and says why. The rest of the subgraph node still works."
      >
        <Panel
          title="Portrait fix"
          uses="used in 1 place"
          entries={[
            input('image', 'image', 'IMAGE', 'Detail pass'),
            input('detail', 'detail', 'FLOAT', 'Detail pass', {
              problem: 'Its row inside Detail pass was removed',
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
              Show a field, group or choice on the subgraph node from its
              right-click menu inside, or drop a wire on the Inputs or Outputs
              panel.
            </span>
            <ProductButton intent="add">Add section</ProductButton>
          </div>
        </Panel>
      </Example>
    </div>
  )
}
