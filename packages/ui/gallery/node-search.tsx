import { For, Show, createSignal } from 'solid-js'
import { ArrowLeft, Download, Folder, PanelTop, Wrench } from 'lucide-solid'
import { autoConnectTarget, cardinalityOf, schemaMatchesPortFilters, typeExprFromTypeId, type NodeSchema, type WidgetRegistry } from '@dinkster/core'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { BlueprintIcon, ProductButton, ProductIcon, ProductMenu, ProductSearch, ProductSearchNodePreview, ProductSearchTypeLabel, ProductSection, productSearchTypeName, productSearchTypeOptions, type ProductSearchGroup } from '../src/index.js'
import { NodeDrawing, node } from './search.js'

type Kind = 'node' | 'blueprint' | 'utility'
interface Entry {
  readonly schema: NodeSchema
  readonly kind: Kind
  readonly category: string
  readonly notInstalled?: boolean
}
const entry = (schema: NodeSchema, kind: Kind = 'node', category = 'Image', notInstalled = false): Entry => ({ schema, kind, category, notInstalled })
const stats = node('Image Stats', [['image', 'IMAGE']], [['stats', 'STRING']], 'Measures the size, range and mean colour of one picture or a list of pictures.')
const ENTRIES = [
  entry(node('Image Batch to List', [['batch', 'IMAGE']], [['images', 'list<IMAGE>']], 'Splits a batch of pictures into a list, one picture each.')),
  entry(node('Image List to Batch', [['images', 'list<IMAGE>']], [['batch', 'IMAGE']], 'Joins a list of pictures into one batch.')),
  entry({ ...stats, body: stats.body.map((row) => row.kind === 'input' ? { ...row, acceptsList: true } : row) }),
  entry(node('Image File', [['image', 'asset<IMAGE>']], [['image', 'asset<IMAGE>']], 'Passes an image file without decoding it.')),
  entry(node('Blend Images', [['first', 'IMAGE'], ['second', 'IMAGE']], [['image', 'IMAGE']], 'Mixes two pictures together.')),
  entry(node('Gradient Image', [], [['image', 'IMAGE']], 'Makes a picture that fades from one colour to another.', [['width', 512], ['height', 512]])),
  entry(node('Invert Image', [['image', 'IMAGE']], [['image', 'IMAGE']], 'Flips every colour of the picture.')),
  entry(node('Save Image (PGM)', [['image', 'IMAGE']], [], 'Writes a picture to the library as a grey PGM file.')),
  entry(node('Upscale Image with Model', [['image', 'IMAGE'], ['model', 'UPSCALE_MODEL']], [['image', 'IMAGE']], 'Makes a picture larger with an upscaling model.'), 'node', 'Image', true),
  entry(node('Upscale image 2x', [['image', 'IMAGE']], [['image', 'IMAGE']], 'Doubles a picture in two gentle steps.'), 'blueprint'),
  entry(node('Reroute', [['value', 'IMAGE']], [['value', 'IMAGE']], 'Carries a wire around other nodes.'), 'utility', 'Loops and tools'),
  entry(node('Number to Text', [['number', 'INT']], [['text', 'STRING']], 'Writes a number as text.'), 'node', 'Notes'),
]
const KINDS = [
  { id: 'all', label: 'All' }, { id: 'node', label: 'Nodes' },
  { id: 'blueprint', label: 'Blueprints' }, { id: 'utility', label: 'Utilities' },
]
const RECENT = ['GradientImage', 'ImageStats']
const image = { kind: 'concrete' as const, name: 'IMAGE' }

function NodeSearchExample(props: { id: string; query?: string; wire?: boolean; list?: boolean; registry: WidgetRegistry }) {
  const [query, setQuery] = createSignal(props.query ?? '')
  const [kind, setKind] = createSignal('all')
  const [wire, setWire] = createSignal(props.wire ?? false)
  const [takes, setTakes] = createSignal<ReadonlySet<string>>(new Set())
  const [gives, setGives] = createSignal<ReadonlySet<string>>(new Set())
  const [category, setCategory] = createSignal<string>()
  const [current, setCurrent] = createSignal<string>()
  const [chosen, setChosen] = createSignal('Nothing chosen yet')
  const anchor = () => props.list ? { kind: 'list' as const, element: image } : image
  const wireName = () => props.list ? 'image list' : 'image'
  const target = (item: Entry) => autoConnectTarget(item.schema, anchor(), 'in')
  const corpus = () => ENTRIES.filter((item) =>
    (!wire() || (!item.notInstalled && target(item) !== undefined)) &&
    (kind() === 'all' || item.kind === kind()) &&
    schemaMatchesPortFilters(item.schema, {
      inputs: [...takes()],
      outputs: [...gives()],
    }),
  )
  const found = () => corpus().filter((item) =>
    (category() === undefined || item.category === category()) &&
    query().toLowerCase().split(/\s+/u).every((word) => item.schema.displayName.toLowerCase().includes(word)),
  )
  const row = (item: Entry) => ({
    key: item.schema.type,
    title: item.schema.displayName,
    icon: item.kind === 'blueprint' ? BlueprintIcon : item.kind === 'utility' ? Wrench : PanelTop,
    detail: item.notInstalled ? 'Not installed' : wire() ? `into ${target(item)!.port}` : 'dev / image',
    ...(item.notInstalled ? { detailIcon: Download } : {}),
  })
  const browsing = () => query().trim() === '' && !wire() && category() === undefined && takes().size === 0 && gives().size === 0
  const groups = (): readonly ProductSearchGroup[] => {
    if (browsing()) {
      const recent = RECENT.flatMap((id) => corpus().filter((item) => item.schema.type === id))
      const categories = [...new Set(corpus().map((item) => item.category))]
      return [
        { key: 'recent', label: 'Recent', rows: recent.map(row) },
        { key: 'categories', label: 'Categories', rows: categories.map((name) => ({
          key: `category:${name}`, title: name, icon: Folder, kind: 'folder', count: corpus().filter((item) => item.category === name).length,
        })) },
      ]
    }
    return [{ key: 'entries', label: wire() ? `Nodes that can take an ${wireName()}` : category() ?? 'Nodes', count: found().length, rows: found().map(row) }]
  }
  const key = () => {
    const keys = groups().flatMap((group) => group.rows.map((item) => item.key))
    return keys.includes(current() ?? '') ? current() : keys[0]
  }
  const selected = () => ENTRIES.find((item) => item.schema.type === key())
  const choose = (id: string) => {
    if (id.startsWith('category:')) {
      setCategory(id.slice(9))
      setCurrent(undefined)
      return
    }
    const item = ENTRIES.find((candidate) => candidate.schema.type === id)
    if (item === undefined) return
    setChosen(item.notInstalled ? `Install ${item.schema.displayName}` : `Place ${item.schema.displayName}${wire() ? ` connected into ${target(item)!.port}` : ''}`)
  }
  const typeMenu = (direction: 'Takes' | 'Gives') => {
    const selectedTypes = () => direction === 'Takes' ? takes() : gives()
    const change = (type: string) => {
      const next = new Set(selectedTypes())
      if (type === '') next.clear()
      else if (next.has(type)) next.delete(type)
      else next.add(type)
      ;(direction === 'Takes' ? setTakes : setGives)(next)
      setCurrent(undefined)
    }
    const valueLabel = () => selectedTypes().size === 0 ? 'Any type' : [...selectedTypes()].map((type) => productSearchTypeName(type.toLowerCase())).join(', ')
    const singleType = () => selectedTypes().size === 1 ? [...selectedTypes()][0]! : ''
    return <ProductMenu
      fill="quiet"
      align={direction === 'Gives' ? 'end' : 'start'}
      label={`${direction}: ${valueLabel()}`}
      title={`${direction}: ${valueLabel()}`}
      labelContent={<ProductSearchTypeLabel label={valueLabel()} direction={direction === 'Takes' ? 'takes' : 'gives'} color={singleType() === '' ? undefined : typeColor(defaultTokens, singleType())} shape={cardinalityOf(typeExprFromTypeId(singleType())) === 'list' ? 'diamond' : 'circle'} />}
      triggerName={`${direction} type`}
      items={['', ...productSearchTypeOptions(['IMAGE', 'list<IMAGE>', 'asset<IMAGE>', 'STRING', 'INT'])].map((type) => ({
        label: `${direction} ${type === '' ? 'Any type' : productSearchTypeName(type.toLowerCase())}`,
        labelContent: <ProductSearchTypeLabel label={type === '' ? 'Any type' : productSearchTypeName(type.toLowerCase())} direction={direction === 'Takes' ? 'takes' : 'gives'} color={type === '' ? undefined : typeColor(defaultTokens, type)} shape={cardinalityOf(typeExprFromTypeId(type)) === 'list' ? 'diamond' : 'circle'} />,
        checked: type === '' ? selectedTypes().size === 0 : selectedTypes().has(type),
        onSelect: () => change(type),
      }))}
    />
  }
  return (
    <div class="dinkster-node-search-example">
      <Show when={category()}>
        <ProductButton onClick={() => { setCategory(undefined); setCurrent(undefined) }}><ProductIcon icon={ArrowLeft} />All categories</ProductButton>
      </Show>
      <ProductSearch
        testId={props.id}
        label="Search nodes"
        placeholder="Search nodes"
        query={query()}
        onQuery={setQuery}
        kinds={KINDS}
        kind={kind()}
        onKind={setKind}
        {...(wire() ? { chip: { label: wireName(), name: `Takes ${wireName()}`, direction: 'takes' as const, color: typeColor(defaultTokens, 'IMAGE'), shape: props.list ? 'diamond' as const : 'circle' as const, removeLabel: 'Remove image constraint', onRemove: () => setWire(false) } } : {})}
        filters={<>
          <Show when={!wire()}>{typeMenu('Takes')}</Show>
          {typeMenu('Gives')}
        </>}
        groups={groups()}
        {...(key() === undefined ? {} : { current: key()! })}
        onCurrent={setCurrent}
        onActivate={choose}
        onClose={() => setChosen('Search closed')}
        empty={{ title: 'No matches', detail: 'Try another name or type.' }}
        hints={[
          { keys: ['Up', 'Down'], label: 'move' },
          { keys: ['Enter'], label: selected()?.notInstalled ? 'install' : key()?.startsWith('category:') ? 'open category' : wire() ? 'place and connect' : 'place' },
          { keys: ['Tab'], label: 'filters' },
          { keys: ['Esc'], label: 'close' },
        ]}
        preview={<Show when={selected()}>{(item) => (
          <ProductSearchNodePreview
            title={item().schema.displayName}
            description={item().schema.description ?? ''}
            place="dev / image - dinkster-nodes-dev"
            flags={item().notInstalled ? ['Not installed'] : []}
            drawing={<NodeDrawing schema={item().schema} registry={props.registry} subgraph={item().kind === 'blueprint'} />}
          />
        )}</Show>}
        previewPlace="beside"
      />
      <p class="dinkster-metadata" data-testid={`${props.id}-chosen`}>{chosen()}</p>
    </div>
  )
}

export function NodeSearchGallery() {
  const registry = createWidgetRegistry()
  const [chosenLabel, setChosenLabel] = createSignal('Nothing chosen yet')
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return <><For each={[
    { title: 'After typing', text: 'The shared search surface with the node drawn beside the list. Packs are named in the preview, not on every row.', id: 'node-search-typed', query: 'image' },
    { title: 'From a dropped wire', text: 'Only installed entries that can take the wire are offered. The row names the input; Enter places and connects.', id: 'node-search-wire', wire: true },
    { title: 'From a dropped list wire', text: 'A list wire finds list inputs and inputs that take either one value or a whole list. A scalar-only input is not offered.', id: 'node-search-list-wire', wire: true, list: true },
    { title: 'Before you type', text: 'What was placed last and the categories to walk through. Opening a category keeps the same search surface.', id: 'node-search-before' },
  ]}>{(example) => <ProductSection title={example.title}>
    <p class="dinkster-description">{example.text}</p>
    <NodeSearchExample {...example} registry={registry} />
  </ProductSection>}</For>
    <ProductSection title="Custom menu labels">
      <p class="dinkster-description">The type word and dot are visible; the full label names each control. Descriptions remain separate from that name.</p>
      <ProductMenu label="Type label examples" triggerName="Choose example type" title="Choose an example type"
        labelContent={<ProductSearchTypeLabel label="image" direction="takes" color={typeColor(defaultTokens, 'IMAGE')} />}
        items={[
          { label: 'Image input', labelContent: <ProductSearchTypeLabel label="image" direction="takes" color={typeColor(defaultTokens, 'IMAGE')} />, onSelect: () => setChosenLabel('Image input') },
          { label: 'Image output', labelContent: <ProductSearchTypeLabel label="image" direction="gives" color={typeColor(defaultTokens, 'IMAGE')} />, description: 'Accepts a picture from the node.', onSelect: () => setChosenLabel('Image output') },
          ...['image', 'mask', 'model', 'latent'].map((type) => ({
            label: `Unavailable ${type} type`,
            description: 'This type cannot be selected in this example. Enabled choices remain reachable above these disabled rows.',
            disabled: true,
            onSelect: () => {},
          })),
        ]} />
      <p class="dinkster-metadata" data-testid="custom-menu-chosen">{chosenLabel()}</p>
    </ProductSection>
  </>
}
