import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { registerCatalog } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasTypePaintForTheme,
  canvasPaintTokens,
  createRegistryPainter,
  defaultTokens,
  previousCanvasTypePaint,
  drawMinimap,
  hitTestBadge,
  type BadgeHit,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
  createCanvasGalleryFixture,
  type CanvasGalleryPage,
} from '../../canvas/gallery/fixtures.js'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductPanel,
  ProductSelect,
  ProductSection,
  ProductTextInput,
} from '../src/index.js'
import { NodeLookGallery } from './node-look.js'
import { RowEditingGallery } from './row-editing.js'

export function CanvasGallery() {
  const [theme, setTheme] = createSignal<'dark' | 'light'>('dark')
  const [page, setPage] = createSignal<CanvasGalleryPage>('anatomy')
  const [widgetId, setWidgetId] = createSignal('float')
  const [rowLook, setRowLook] = createSignal<DesignTokens['widgetRowLook']>(
    defaultTokens.widgetRowLook,
  )
  const [collectionLook, setCollectionLook] = createSignal<
    DesignTokens['widgetRowLook']
  >('inset-raised-collections')
  const [outline, setOutline] = createSignal('quieter')
  const [typeLook, setTypeLook] = createSignal('current')
  const [titleLook, setTitleLook] = createSignal(defaultTokens.titleOverflow)
  const [boundaryNames, setBoundaryNames] = createSignal<'current' | 'ids'>(
    'ids',
  )
  const [tabLook, setTabLook] = createSignal<'tabs' | 'chips'>('tabs')
  const [tabSize, setTabSize] = createSignal(defaultTokens.badgeTab)
  const [badgeDetails, setBadgeDetails] = createSignal<BadgeHit>()
  let canvas!: HTMLCanvasElement
  registerCatalog('en', english)
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  createEffect(() => {
    const currentTheme = theme()
    const currentPage = page()
    const currentWidget = widgetId()
    const currentRowLook = rowLook()
    const currentCollectionLook = collectionLook()
    const currentOutline = outline()
    const currentTypeLook = typeLook()
    const currentTitleLook = titleLook()
    const currentBoundaryNames = boundaryNames()
    const currentTabLook = tabLook()
    const currentTabSize = tabSize()
    const tabsPage =
      currentPage === 'tabs' ||
      currentPage === 'tabs-content' ||
      currentPage === 'run-editable' ||
      currentPage === 'run-frozen'
    document.documentElement.dataset.theme = currentTheme
    if (currentPage === 'row-editing' || currentPage === 'node-look') return
    let disposed = false
    let renderer: CanvasRenderer | undefined
    let removeBadgeListeners: (() => void) | undefined
    void Promise.all([
      document.fonts.load(
        `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `italic ${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
    ]).then(() => {
      if (disposed) return
      const colors = canvasColorsForTheme(currentTheme)
      const tokens: DesignTokens = {
        ...defaultTokens,
        widgetRowLook:
          currentPage === 'collection-rows'
            ? currentCollectionLook
            : currentPage === 'core-rows'
              ? currentRowLook
              : defaultTokens.widgetRowLook,
        badgeLayout: tabsPage ? currentTabLook : defaultTokens.badgeLayout,
        badgeTab: tabsPage ? currentTabSize : defaultTokens.badgeTab,
        titleOverflow:
          currentPage === 'titles' || currentPage === 'titles-content'
            ? currentTitleLook
            : defaultTokens.titleOverflow,
        ...(currentPage === 'types' && currentTypeLook === 'previous'
          ? previousCanvasTypePaint
          : canvasTypePaintForTheme(currentTheme)),
        colors: {
          ...colors,
          ...(currentPage === 'idle-outline' && currentOutline === 'previous'
            ? { nodeIdleOutline: colors.nodeOutline }
            : {}),
        },
      }
      const measureContext = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        measureContext.font = `${role === 'title' || role === 'renamedTitle' ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${role === 'title' || role === 'renamedTitle' ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return measureContext.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = registry.kind(spec.widgetType)
        const view = registry
          .viewsFor(spec.widgetType)
          .find((view) => view.id === kind?.defaultView(spec))
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      const fixture = createCanvasGalleryFixture(
        currentPage,
        tokens,
        measure,
        widgetMeasure,
        galleryWidgetInputs.find((input) => input.id === currentWidget)!,
        currentBoundaryNames,
      )
      canvas.style.width = `${fixture.width}px`
      canvas.style.height = `${fixture.height}px`
      renderer = new CanvasRenderer(
        canvas,
        tokens,
        createRegistryPainter(registry),
      )
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(fixture.scene)
      renderer.setNodeStates(fixture.states)
      renderer.setBadges(fixture.badges)
      renderer.setOverlay(fixture.overlay)
      renderer.setRowMarks(fixture.rowMarks)
      renderer.setCompanions(fixture.companions)
      renderer.setToolbox(fixture.toolbox)
      const image = document.createElement('canvas')
      image.width = 320
      image.height = 160
      const imageContext = image.getContext('2d')!
      imageContext.fillStyle = tokens.colors.nodeHeader
      imageContext.fillRect(0, 0, 320, 160)
      imageContext.fillStyle = tokens.colors.selection
      imageContext.beginPath()
      imageContext.arc(210, 65, 42, 0, Math.PI * 2)
      imageContext.fill()
      renderer.setNodePreviews(
        currentPage === 'previews'
          ? {
              ...fixture.previews,
              Image: { image, width: 320, height: 160 },
              Cached: { image, width: 320, height: 160, state: 'cached' },
              Estimate: { image, width: 320, height: 160, state: 'estimate' },
            }
          : fixture.previews,
      )
      renderer.setViewport({ x: 0, y: 0, scale: fixture.scale })
      renderer.renderNow()
      const paintLabels = () => {
        const labelContext = canvas.getContext('2d')!
        labelContext.save()
        labelContext.setTransform(
          window.devicePixelRatio * fixture.scale,
          0,
          0,
          window.devicePixelRatio * fixture.scale,
          0,
          0,
        )
        labelContext.font = `${tokens.fontSize}px ${tokens.fontFamily}`
        labelContext.fillStyle = tokens.colors.label
        labelContext.textBaseline = 'middle'
        if (currentPage === 'titles' || currentPage === 'titles-content')
          labelContext.textAlign = 'left'
        for (const label of fixture.labels)
          labelContext.fillText(label.text, label.x, label.y)
        labelContext.restore()
      }
      paintLabels()
      if (tabsPage) {
        const live = renderer
        const hit = (event: PointerEvent | MouseEvent) => {
          const rect = canvas.getBoundingClientRect()
          return hitTestBadge(
            live.getScene(),
            fixture.badges,
            (event.clientX - rect.left) / fixture.scale,
            (event.clientY - rect.top) / fixture.scale,
            (node) => live.getNodeBadgeLayout(node),
          )
        }
        const hover = (event: PointerEvent) => {
          const target = event.type === 'pointerleave' ? undefined : hit(event)
          canvas.title = target
            ? (target.overflow ?? [target.badge])
                .map((badge) => badge.glyph)
                .join(', ')
            : ''
          live.setOverlay({
            ...fixture.overlay,
            ...(target
              ? {
                  hoveredBadge: {
                    nodeId: target.node.id,
                    badgeId: target.badge.id,
                  },
                }
              : {}),
          })
          live.renderNow()
          paintLabels()
        }
        const activate = (event: MouseEvent) => setBadgeDetails(hit(event))
        canvas.addEventListener('pointermove', hover)
        canvas.addEventListener('pointerleave', hover)
        canvas.addEventListener('click', activate)
        removeBadgeListeners = () => {
          canvas.removeEventListener('pointermove', hover)
          canvas.removeEventListener('pointerleave', hover)
          canvas.removeEventListener('click', activate)
        }
      }
      if (currentPage === 'minimap') {
        renderer.dispose()
        renderer = undefined
        const ctx = canvas.getContext('2d')!
        ctx.resetTransform()
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
        drawMinimap(ctx, {
          width: fixture.width,
          height: fixture.height,
          tokens,
          nodes: fixture.scene.nodes.map((node) => ({
            x: node.x,
            y: node.y,
            width: node.layout.width,
            height: node.layout.height,
            ...(fixture.states[node.id]
              ? { state: fixture.states[node.id]!.state }
              : {}),
            bypassed: node.node.mode === 'bypassed',
            ...(node.color ? { color: node.color } : {}),
          })),
          groups: fixture.scene.groups,
          links: fixture.scene.links.map((link) => ({
            from: { x: link.x1, y: link.y1 },
            to: { x: link.x2, y: link.y2 },
          })),
          reroutes: fixture.scene.reroutes,
          viewport: {
            x: 0,
            y: 0,
            scale: 1,
            canvasWidth: 600,
            canvasHeight: 350,
          },
        })
      }
      canvas.dataset.ready = `${currentPage}-${currentTheme}`
      canvas.dataset.widget = currentWidget
      canvas.dataset.outline = currentOutline
      canvas.dataset.typeLook = currentTypeLook
      canvas.dataset.titleLook = currentTitleLook
      canvas.dataset.rowLook = tokens.widgetRowLook
      canvas.dataset.boundaryNames = currentBoundaryNames
      canvas.dataset.tabLook = currentTabLook
      canvas.dataset.tabSize = `${currentTabSize.height}-${currentTabSize.fontSize}-${currentTabSize.inset}`
    })
    onCleanup(() => {
      disposed = true
      removeBadgeListeners?.()
      canvas.removeAttribute('title')
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  onCleanup(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  return (
    <>
      <div class="dinkster-actions" aria-label="Canvas theme">
        <ProductButton
          aria-pressed={theme() === 'dark'}
          onClick={() => setTheme('dark')}
        >
          Dark theme
        </ProductButton>
        <ProductButton
          aria-pressed={theme() === 'light'}
          onClick={() => setTheme('light')}
        >
          Light theme
        </ProductButton>
      </div>
      <nav class="dinkster-actions" aria-label="Canvas pages">
        <For each={canvasGalleryPages}>
          {([id, label]) => (
            <ProductButton
              aria-pressed={page() === id}
              onClick={() => setPage(id)}
            >
              {label}
            </ProductButton>
          )}
        </For>
      </nav>
      <Show when={page() === 'core-rows'}>
        <ProductField label="Core row look">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={rowLook()}
              onChange={(event) =>
                setRowLook(
                  event.currentTarget.value as DesignTokens['widgetRowLook'],
                )
              }
            >
              <option value="inset-raised">
                Inset fields and raised openers
              </option>
              <option value="inset">Previous inset rows</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Direct values use inset fields; color and asset rows have raised
          faces, kind icons and an opening chevron. Values, swatches, empty
          states and long names come from the fixture document. Previous inset
          rows compares the old paint on this page only. Number paint is
          unchanged, not the number-editing proposal.
        </p>
      </Show>
      <Show when={page() === 'collection-rows'}>
        <ProductField label="Collection row look">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={collectionLook()}
              onChange={(event) =>
                setCollectionLook(
                  event.currentTarget.value as DesignTokens['widgetRowLook'],
                )
              }
            >
              <option value="inset-raised-collections">
                Raised collection openers
              </option>
              <option value={defaultTokens.widgetRowLook}>
                Current collection rows
              </option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Gallery-only collection row proposal. Multi-choice, list, palette and
          curve rows open editors and have raised faces, kind icons and
          chevrons. Counts, list text, color swatches and curve samples come
          from document values. A curve requires at least one point; the minimal
          example is flat. Production defaults and editor appearances are
          unchanged.
        </p>
      </Show>
      <Show when={page() === 'idle-outline'}>
        <ProductField label="Outline look">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={outline()}
              onChange={(event) => setOutline(event.currentTarget.value)}
            >
              <option value="previous">Previous outline</option>
              <option value="quieter">Quieter outline (current)</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          The app uses the quieter idle outline from the shared subtle border.
          Compare it with the previous outline. Hover and selection paint stay
          unchanged.
        </p>
      </Show>
      <Show when={page() === 'boundary-names'}>
        <ProductField label="Boundary names">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={boundaryNames()}
              onChange={(event) =>
                setBoundaryNames(event.currentTarget.value as 'current' | 'ids')
              }
            >
              <option value="ids">Ids as written</option>
              <option value="current">Generated names (previous)</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Compare production ids as written with previous generated names inside
          a subgraph and on its collapsed occurrence. Custom display names stay
          unchanged; unnamed outputs retain their capitalized data type. Only
          the previous-name comparison stages labels in the gallery document.
        </p>
      </Show>
      <Show when={page() === 'types'}>
        <ProductField label="Type colors">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={typeLook()}
              onChange={(event) => setTypeLook(event.currentTarget.value)}
            >
              <option value="current">
                Contrast-adjusted colors (current)
              </option>
              <option value="previous">Previous colors</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Current type colors keep each type's hue and reach at least 3:1
          contrast against the node body. Previous colors overrides only this
          comparison; app colors and other gallery pages keep the current
          palette.
        </p>
      </Show>
      <Show when={page() === 'titles' || page() === 'titles-content'}>
        <ProductField label="Title fitting">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={titleLook()}
              onChange={(event) =>
                setTitleLook(
                  event.currentTarget.value as 'squeeze' | 'ellipsis',
                )
              }
            >
              <option value="ellipsis">Ellipsis (current)</option>
              <option value="squeeze">Squeezed titles (previous)</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Compare fitting, long, renamed and minimized titles, including header
          marks. Current titles keep letter widths and end in an ellipsis when
          crowded. Previous squeezing overrides only this comparison; app titles
          and other gallery pages keep ellipsis.
        </p>
      </Show>
      <Show when={page() === 'run-editable' || page() === 'run-frozen'}>
        <p class="dinkster-description">
          Gallery-only run presentation. The editable workflow shows running and
          failed nodes only; the frozen run shows every recorded state.
          Collapsed nodes aggregate their occurrences before filtering. Nodes
          without execution stay unmarked. These pages do not change production
          run paint; tab dimensions remain an adjustable, unapproved proposal.
        </p>
      </Show>
      <Show
        when={
          page() === 'tabs' ||
          page() === 'tabs-content' ||
          page() === 'run-editable' ||
          page() === 'run-frozen'
        }
      >
        <ProductField label="Badge layout">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={tabLook()}
              onChange={(event) =>
                setTabLook(event.currentTarget.value as 'tabs' | 'chips')
              }
            >
              <option value="tabs">Attached tabs (proposal)</option>
              <option value="chips">Current chips</option>
            </ProductSelect>
          )}
        </ProductField>
        <div class="dinkster-actions">
          <For
            each={
              [
                ['height', 'Tab height'],
                ['fontSize', 'Tab text size'],
                ['inset', 'Tab side inset'],
              ] as const
            }
          >
            {([key, label]) => (
              <ProductField label={label}>
                {(attributes) => (
                  <ProductSelect
                    {...attributes}
                    value={tabSize()[key]}
                    onChange={(event) =>
                      setTabSize((size) => ({
                        ...size,
                        [key]: Number(event.currentTarget.value),
                      }))
                    }
                  >
                    <For
                      each={[
                        defaultTokens.badgeTab[key],
                        canvasPaintTokens.badge.roomierTab[key],
                      ]}
                    >
                      {(value) => <option value={value}>{value}px</option>}
                    </For>
                  </ProductSelect>
                )}
              </ProductField>
            )}
          </For>
        </div>
        <p class="dinkster-description">
          Gallery-only proposal. Adjust height, text size and side inset
          independently; none of these dimensions is approved. Hover a crowded
          strip to read it; click +N to read the folded details. Production
          keeps current chips.
        </p>
      </Show>
      <Show when={page() === 'widget-states'}>
        <ProductField label="Widget kind">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={widgetId()}
              onChange={(event) => setWidgetId(event.currentTarget.value)}
            >
              <For each={galleryWidgetInputs}>
                {(input) => <option value={input.id}>{input.id}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
      </Show>
      <Show
        when={page() !== 'row-editing' && page() !== 'node-look'}
        fallback={
          page() === 'node-look' ? (
            <>
              <p class="dinkster-description">
                The same nodes in the original look and in the new look the
                owner chose: taller fields, tighter gaps, steppers moved
                inward, a dark body and the title bar in the body's color over
                a thin line. Painted by the production CanvasRenderer.
              </p>
              <NodeLookGallery theme={theme()} />
            </>
          ) : (
          <>
            <p class="dinkster-description">
              Number, single-line text and seed rows become their own field
              when clicked, with their limits beside the node. Painted by the
              production CanvasRenderer with the in-row field over it; the
              product still edits these rows in a card.
            </p>
            <RowEditingGallery theme={theme()} />
          </>
          )
        }
      >
        <ProductSection
          title={canvasGalleryPages.find(([id]) => id === page())![1]}
        >
          <p class="dinkster-description">
            Fixed examples painted by the production CanvasRenderer and
            registered widget views, without a backend.
          </p>
          <div class="dinkster-table-scroll">
            <canvas
              ref={canvas}
              role="img"
              aria-label={`${page()} in ${theme()} theme`}
            />
          </div>
        </ProductSection>
      </Show>
      <Show when={page() === 'core-rows'}>
        <ProductSection
          title="Canvas text input"
          description="The shared text field at canvas density, not a number-editing proposal. Values remain exact strings; no parsing or editor behavior is added."
        >
          <ProductPanel>
            <ProductField label="Default field">
              {(attributes) => <ProductTextInput {...attributes} value="42" />}
            </ProductField>
            <ProductField label="Canvas seed">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  inputMode="numeric"
                  value="18446744073709551615"
                />
              )}
            </ProductField>
            <ProductField label="Canvas decimal">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  inputMode="decimal"
                  value="-0.125"
                />
              )}
            </ProductField>
            <ProductField label="Unavailable canvas field">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  disabled
                  value="24"
                />
              )}
            </ProductField>
            <ProductField label="Read-only canvas field">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  readOnly
                  value="9007199254740993"
                />
              )}
            </ProductField>
            <ProductField
              label="Invalid canvas field"
              error="Enter a numeric value."
            >
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  value="not a number"
                />
              )}
            </ProductField>
          </ProductPanel>
        </ProductSection>
      </Show>
      <Show when={badgeDetails()}>
        {(details) => (
          <ProductDialog
            title="Node details"
            onDismiss={() => setBadgeDetails(undefined)}
          >
            <For each={details().overflow ?? [details().badge]}>
              {(badge) => <p class="dinkster-description">{badge.glyph}</p>}
            </For>
            <ProductButton onClick={() => setBadgeDetails(undefined)}>
              Close
            </ProductButton>
          </ProductDialog>
        )}
      </Show>
    </>
  )
}
