import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { Images, LayoutTemplate } from 'lucide-solid'
import { registerCatalog } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import {
  WorkflowTabs,
  workflowTabDomId,
  type WorkflowTabItem,
} from '../../app/src/WorkflowTabs.js'
import {
  createPageTabHost,
  isPageTab,
  PageTabPanel,
  type PageTab,
} from '../../app/src/page-tabs.js'
import {
  ProductButton,
  ProductCheckbox,
  ProductField,
  ProductLink,
  ProductPage,
  ProductSection,
  ProductTextInput,
} from '../src/index.js'

/** Real shared tab chrome and host, with small pages instead of product screens. */
export function PageTabsGallery() {
  registerCatalog('en', english)
  const [tabs, setTabs] = createSignal<readonly (WorkflowTabItem | PageTab)[]>([
    { id: 'workflow', title: 'Diner shot', editorKind: 'graph' },
  ])
  const [activeId, setActiveId] = createSignal('workflow')
  const [enabled, setEnabled] = createSignal(true)
  const [note, setNote] = createSignal('Frame 12')
  const [saved, setSaved] = createSignal('Frame 12')
  const [theme, setTheme] = createSignal<'dark' | 'light'>('dark')
  const initialTheme = document.documentElement.dataset['theme']
  createEffect(() => {
    document.documentElement.dataset['theme'] = theme()
  })
  onCleanup(() => {
    if (initialTheme === undefined)
      delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = initialTheme
  })
  const host = createPageTabHost<WorkflowTabItem>({
    tabs,
    setTabs,
    activeId,
    setActiveId,
  })
  let ordinal = 0
  onCleanup(
    host.register({
      id: 'templates',
      title: 'Templates',
      icon: LayoutTemplate,
      enabled,
      component: (context) => (
        <ProductSection
          title="Templates page example"
          description="This example demonstrates replacing a page, not the Templates product page."
        >
          <p class="dinkster-description">
            {String(context.tab.parameters ?? 'All templates')}
          </p>
          <div class="dinkster-row">
            <ProductButton
              intent="add"
              fill="solid"
              onClick={() =>
                context.replaceWithWorkflow({
                  id: `template-${++ordinal}`,
                  title: 'Teapot shots',
                  editorKind: 'graph',
                })
              }
            >
              Use example template
            </ProductButton>
            <ProductButton
              intent="add"
              fill="outline"
              onClick={() =>
                context.replaceWithWorkflow({
                  id: `blank-${++ordinal}`,
                  title: 'Untitled',
                  editorKind: 'graph',
                })
              }
            >
              Blank workflow
            </ProductButton>
          </div>
        </ProductSection>
      ),
    }),
  )
  onCleanup(
    host.register({
      id: 'board',
      title: 'Board',
      icon: Images,
      dirty: () => note() !== saved(),
      save: () => {
        setSaved(note())
      },
      snapshot: () => ({ note: note() }),
      component: () => (
        <ProductSection
          title="Board page example"
          description="Page-owned data survives switching tabs; workflow sessions are not involved."
        >
          <ProductField label="Board note">
            {(attributes) => (
              <ProductTextInput
                {...attributes}
                value={note()}
                onInput={(event) => setNote(event.currentTarget.value)}
              />
            )}
          </ProductField>
          <ProductButton
            fill="solid"
            disabled={note() === saved()}
            onClick={() => host.descriptor('board')?.save?.()}
          >
            Save note
          </ProductButton>
        </ProductSection>
      ),
    }),
  )
  host.open('templates', 'Image templates')
  host.open('board')
  const active = () => tabs().find((tab) => tab.id === activeId())
  return (
    <div class="dinkster-page">
      <ProductPage
        title="Shared page tabs"
        description="Pages and workflows use one strip. Open a page again to focus it, or turn it into a workflow in place."
      >
        <ProductLink href="#editor-bar">
          Compare the editor tab strip
        </ProductLink>
        <div class="dinkster-row">
          <ProductButton
            fill="outline"
            onClick={() => host.open('templates', 'Image templates')}
            disabled={!enabled()}
          >
            Open Templates
          </ProductButton>
          <ProductButton fill="outline" onClick={() => host.open('board')}>
            Open Board
          </ProductButton>
          <ProductButton
            fill="outline"
            onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}
          >
            Change theme
          </ProductButton>
          <ProductCheckbox
            label="Templates enabled"
            checked={enabled()}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
        </div>
        <div class="dinkster-workflow-tabs-preview">
          <div class="tab-strip">
            <WorkflowTabs
              label="Open tabs"
              tabs={tabs()}
              activeId={activeId()}
              isDirty={(tab) =>
                isPageTab(tab) &&
                host.descriptor(tab.pageId)?.dirty?.() === true
              }
              isFrozen={() => false}
              isShared={() => false}
              setRoot={() => {}}
              onActivate={(_event, tab) => setActiveId(tab.id)}
              onClose={(tab) => {
                const focused =
                  document.activeElement
                    ?.closest('[data-tab-id]')
                    ?.getAttribute('data-tab-id') === tab.id
                host.close(tab.id)
                if (focused)
                  queueMicrotask(() =>
                    document
                      .getElementById(workflowTabDomId(activeId()))
                      ?.focus(),
                  )
              }}
              onPointerDown={() => {}}
              onNew={() => {
                const tab = {
                  id: `new-${++ordinal}`,
                  title: 'Untitled',
                  editorKind: 'graph',
                }
                setTabs([...tabs(), tab])
                setActiveId(tab.id)
              }}
              canShare={() => false}
              onShare={() => {}}
              panelId="page-tabs-panel"
            />
          </div>
          <div
            id="page-tabs-panel"
            class="dinkster-page dinkster-stack"
            role="tabpanel"
            aria-labelledby={workflowTabDomId(activeId())}
          >
            <Show
              when={active()}
              keyed
              fallback={<p class="dinkster-description">No tabs open</p>}
            >
              {(tab) =>
                isPageTab(tab) ? (
                  <PageTabPanel host={host} tab={tab} />
                ) : (
                  <ProductSection
                    title={tab.title}
                    description="Workflow editor example"
                  >
                    <p class="dinkster-description">
                      The workflow tab now occupies this position.
                    </p>
                  </ProductSection>
                )
              }
            </Show>
          </div>
        </div>
      </ProductPage>
    </div>
  )
}
