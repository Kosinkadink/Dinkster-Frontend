import { BoardStore, emptyBoard } from '@dinkster/core'
import {
  ProductBoard,
  ProductButton,
  ProductImage,
  ProductSection,
} from '../src/index.js'

export function ResultPicturesGallery() {
  const store = new BoardStore(emptyBoard())
  store.dispatch({
    command: 'board.item.add',
    params: {
      items: [
        {
          id: 'missing',
          kind: 'picture',
          rect: { x: 0, y: 0, width: 160, height: 100 },
          asset: {
            digest: 'missing',
            name: 'Missing result',
            mediaType: 'image/jpeg',
          },
        },
        {
          id: 'present',
          kind: 'picture',
          rect: { x: 180, y: 0, width: 160, height: 100 },
          asset: {
            digest: 'present',
            name: 'Present result',
            mediaType: 'image/jpeg',
          },
        },
      ],
    },
  })
  return (
    <>
      <ProductSection title="Small result pictures">
        <p class="dinkster-metadata">
          Unavailable pictures retain an accessible name and show only the grey
          picture icon. Loaded pictures keep their normal rendering.
        </p>
        <div class="dinkster-result-picture-examples">
          <ProductImage src="/missing-result.jpg" alt="Missing result" />
          <ProductImage src="/templates/diner.jpg" alt="Present result" />
        </div>
      </ProductSection>
      <ProductSection title="Board results">
        <ProductBoard
          store={store}
          viewControls={(view) => (
            <ProductButton onClick={view.onFit}>Fit to view</ProductButton>
          )}
          assetUrl={(asset) =>
            asset.digest === 'missing'
              ? '/missing-result.jpg'
              : '/templates/diner.jpg'
          }
        />
      </ProductSection>
    </>
  )
}
