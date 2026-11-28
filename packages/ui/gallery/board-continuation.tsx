import { BoardStore, emptyBoard, type CollectionEntry } from '@dinkster/core'
import { createSignal } from 'solid-js'
import { Workflow } from 'lucide-solid'
import { BlueprintIcon, ProductBoard, ProductBoardCard, ProductBoardResultBar, ProductButton, ProductSection } from '../src/index.js'

/** Shared action chrome with fixed gallery sources; no backend or generation. */
export function BoardContinuationGallery() {
  const store = new BoardStore(emptyBoard())
  const [empty, setEmpty] = createSignal(false)
  const [requested, setRequested] = createSignal('No chooser requested')
  const sources: readonly CollectionEntry[] = [
    { id: 'details', title: 'Enhance details', kind: 'workflow' },
    { id: 'video', title: 'Image to video', kind: 'blueprint' },
  ]
  store.dispatch({ command: 'board.item.add', params: { items: [
    { id: 'picture', kind: 'picture', asset: { digest: `blake3:${'a'.repeat(64)}`, name: 'Diner at night.jpg', mediaType: 'image/jpeg' },
      rect: { x: 40, y: 24, width: 310, height: 194 } },
    { id: 'sound', kind: 'sound', asset: { digest: `blake3:${'b'.repeat(64)}`, name: 'Reference chimes.wav', mediaType: 'audio/wav' },
      rect: { x: 40, y: 390, width: 310, height: 90 } },
  ] } })
  let ordinal = 0
  return <ProductSection title="Continue with">
    <p class="dinkster-metadata">Component preview with fixed sources, not application acceptance evidence. Chooser actions report their request here; the application owns the shared chooser.</p>
    <p class="dinkster-metadata" role="status">{requested()}</p>
    <ProductButton onClick={() => setEmpty((value) => !value)}>{empty() ? 'Show compatible sources' : 'Show no compatible sources'}</ProductButton>
    <ProductBoard store={store}
      assetUrl={(asset) => asset.mediaType.startsWith('audio/') ? '/board/chimes.wav' : '/templates/diner.jpg'}
      viewControls={() => null}
      result={(item, select, remove, actionsRef) => {
        const place = (entry: CollectionEntry) => {
          const origin = item()
          const id = `continued-${++ordinal}`
          const inputKey = '["root","source","picture"]'
          const result = store.dispatch({ command: 'board.item.add', params: { items: [{
            id, kind: entry.kind as 'workflow' | 'blueprint', name: entry.title,
            source: { kind: 'library', recordId: entry.id }, values: { [inputKey]: { ...origin.asset } },
            continuedFrom: { itemId: origin.id, inputKey },
            rect: { x: origin.rect.x + origin.rect.width + 24 + (ordinal - 1) * 364, y: origin.rect.y, width: 340, height: 188 },
          }] } })
          if (result.ok) select(id)
        }
        return <ProductBoardResultBar actionsRef={actionsRef} onRemove={remove}
          continuation={{ kind: item().kind,
            recent: empty() ? [] : sources.map((entry) => ({ label: entry.title,
              icon: entry.kind === 'blueprint' ? BlueprintIcon : Workflow, onSelect: () => place(entry) })),
            onChooseWorkflow: () => setRequested('Workflow chooser requested'),
            onChooseBlueprint: () => setRequested('Blueprint chooser requested'),
          }} />
      }}
      card={(card, remove, inputPosition) => <ProductBoardCard name={card().name} kind={card().kind}
        lastRun="Not run" onRun={() => undefined} disabled onStop={() => undefined} onRemove={remove}
        onInputPosition={(key, offset) => inputPosition(key, offset, () => card().values[key])}>
        <p data-board-input-key={card().continuedFrom?.inputKey} class="dinkster-metadata">{(Object.values(card().values)[0] as { name: string }).name}</p>
      </ProductBoardCard>} />
  </ProductSection>
}
