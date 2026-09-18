import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { coreCommandRegistry, createLocalSession, loadDocument } from '@dinkster/core'
import { ProductTabs, type ProductTab } from './ProductTabs.js'
import './styles.css'

declare global {
  interface Window {
    __tabsProofRevision: () => number
    __tabsProofPrepareRemoval: () => void
    __tabsProofRemove: (id: string) => void
  }
}

const loaded = loadDocument({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'tabs-proof',
  root: 'g0',
  graphs: {
    g0: { id: 'g0', name: 'Proof', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
  },
  view: { graphs: { g0: { nodes: {} } } },
})
if (loaded.document === undefined) throw new Error('tabs proof document failed validation')
const session = createLocalSession(loaded.document, coreCommandRegistry())
window.__tabsProofRevision = () => session.revision

const initialTabs: readonly ProductTab[] = [
  { id: 'overview', label: 'Overview', panel: <p>Overview content</p> },
  { id: 'disabled', label: 'Disabled', panel: <p>Disabled content</p>, disabled: true },
  { id: 'activity', label: 'Activity', panel: <p>Activity content</p> },
]
const [tabs, setTabs] = createSignal(initialTabs)
window.__tabsProofPrepareRemoval = () => setTabs([
  initialTabs[0]!,
  { id: 'nearby', label: 'Nearby', panel: <p>Nearby content</p> },
  initialTabs[1]!,
  initialTabs[2]!,
])
window.__tabsProofRemove = (id) => setTabs((current) => current.filter((tab) => tab.id !== id))

render(
  () => (
    <main style={{ width: '520px', margin: '80px auto' }}>
      <h1>Product tabs proof</h1>
      <button type="button" data-testid="outside-focus">Outside focus target</button>
      <ProductTabs tabs={tabs()} ariaLabel="Proof inspector" defaultSelectedId="overview" />
    </main>
  ),
  document.getElementById('root')!,
)
