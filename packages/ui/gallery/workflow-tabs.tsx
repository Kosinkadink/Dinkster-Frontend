import { For } from 'solid-js'
import { Plus, Snowflake, Workflow } from 'lucide-solid'
import { ProductIcon, ProductRunIcon } from '../src/index.js'

const tabs: readonly {
  title: string
  dirty: boolean
  frozen?: boolean
  result?: 'finished' | 'failed'
}[] = [
  { title: 'Untitled', dirty: true, result: 'finished' },
  { title: 'Diner shot', dirty: true, result: 'failed' },
  { title: 'Teapot shots', dirty: false },
  { title: 'Frozen run', dirty: false, frozen: true, result: 'finished' },
]

/** The app's workflow tab row, drawn with its classes over a strip of canvas. */
function TabRow(props: { active: number; theme: 'dark' | 'light' }) {
  return (
    <div class="dinkster-workflow-tabs-preview" data-theme={props.theme}>
      <div class="tab-strip">
        <div class="workflow-tabs">
          <div class="workflow-tablist">
            <For each={tabs}>
              {(tab, index) => (
                <div class={index() === props.active ? 'tab active' : 'tab'}>
                  <span class="tab-select">
                    <ProductRunIcon
                      icon={tab.frozen ? Snowflake : Workflow}
                      result={tab.result}
                    />
                    <span class="tab-title">{tab.title}</span>
                  </span>
                  <span class="tab-affordance">
                    {tab.dirty && <span class="tab-dirty" />}
                  </span>
                </div>
              )}
            </For>
            <span class="tab-new">
              <ProductIcon icon={Plus} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function WorkflowTabsGallery() {
  return (
    <div class="dinkster-stack">
      <For each={['dark', 'light'] as const}>
        {(theme) => (
          <For each={[0, 1, 2, 3]}>
            {(active) => <TabRow active={active} theme={theme} />}
          </For>
        )}
      </For>
    </div>
  )
}
