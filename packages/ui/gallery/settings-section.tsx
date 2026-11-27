import { createSignal } from 'solid-js'
import {
  ProductFacts,
  ProductSettingsSection,
  ProductSwitch,
  ProductTextInput,
} from '../src/index.js'

export function SettingsSectionGallery() {
  const [smooth, setSmooth] = createSignal(true)
  const [map, setMap] = createSignal(true)
  const [zoom, setZoom] = createSignal('100')
  return <div class="dinkster-stack">
    <ProductSettingsSection title="View">
      <ProductFacts label="View settings" items={[
        { label: 'Smooth wheel zoom', value: <ProductSwitch label="Smooth wheel zoom" checked={smooth()} onChange={setSmooth} /> },
        { label: 'Default zoom', value: <ProductTextInput aria-label="Default zoom" value={zoom()} onInput={(event) => setZoom(event.currentTarget.value)} /> },
      ]} />
    </ProductSettingsSection>
    <ProductSettingsSection title="Minimap">
      <ProductFacts label="Minimap settings" items={[
        { label: 'Show minimap', value: <ProductSwitch label="Show minimap" checked={map()} onChange={setMap} /> },
      ]} />
    </ProductSettingsSection>
  </div>
}
