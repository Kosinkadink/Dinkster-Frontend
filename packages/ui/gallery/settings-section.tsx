import { createSignal } from 'solid-js'
import {
  ProductFacts,
  ProductSelect,
  ProductSettingsSection,
  ProductSwitch,
  ProductTextInput,
} from '../src/index.js'

export function SettingsSectionGallery() {
  const [smooth, setSmooth] = createSignal(true)
  const [map, setMap] = createSignal(true)
  const [zoom, setZoom] = createSignal('100')
  const [theme, setTheme] = createSignal('System')
  return <div class="dinkster-stack">
    <ProductSettingsSection title="View">
      <ProductFacts label="View settings" items={[
        { label: 'Smooth wheel zoom', value: <ProductSwitch label="Smooth wheel zoom" checked={smooth()} onChange={setSmooth} /> },
        { label: 'Default zoom', value: <ProductTextInput aria-label="Default zoom" value={zoom()} onInput={(event) => setZoom(event.currentTarget.value)} /> },
        { label: 'Color theme', value: <ProductSelect aria-label="Color theme" value={theme()} onChange={(event) => setTheme(event.currentTarget.value)}>
          {['System', 'Dark', 'Light'].map((value) => <option value={value}>{value}</option>)}
        </ProductSelect> },
      ]} />
    </ProductSettingsSection>
    <ProductSettingsSection title="Minimap">
      <ProductFacts label="Minimap settings" items={[
        { label: 'Show minimap', value: <ProductSwitch label="Show minimap" checked={map()} onChange={setMap} /> },
      ]} />
    </ProductSettingsSection>
  </div>
}
