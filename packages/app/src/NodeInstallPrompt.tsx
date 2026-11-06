import type { AppState } from './app-state.js'
import type { CatalogNode } from './node-catalog.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton } from './ProductControls.js'
import { SchemaPreview } from './SchemaPreview.js'
import { useAppMessage } from './locale.js'

export function NodeInstallPrompt(props: { readonly app: AppState; readonly request: CatalogNode & { readonly backendId: string } }) {
  const message = useAppMessage()
  const close = () => { props.app.nodeInstallRequest.set(undefined) }
  return <ModalSurface title={message('search.installTitle')} modalId="node-install" onRequestClose={close}>
    <div class="search-result-preview">
      <h2>{props.request.schema.displayName}</h2>
      <p>{props.request.pack.displayName} - {props.request.pack.version} - {message('search.notInstalled')}</p>
      <SchemaPreview schema={props.request.schema} widgets={props.app.widgetRegistryForTab(props.app.activeTab())} />
      <p>{props.request.schema.description}</p>
      <dl><div><dt>{message('search.platforms')}</dt><dd>{props.request.pack.platforms.join(', ')}</dd></div></dl>
      <p role="status">{message('search.installUnavailable')}</p>
      <ProductButton onClick={close}>{message('search.close')}</ProductButton>
    </div>
  </ModalSurface>
}
