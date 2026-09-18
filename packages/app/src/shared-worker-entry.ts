import { SharedWorkerDocumentAuthority } from './shared-worker-authority.js'

const authority = new SharedWorkerDocumentAuthority()
const worker = self as unknown as {
  onconnect: ((event: { readonly ports: readonly MessagePort[] }) => void) | null
}
worker.onconnect = (event) => {
  const port = event.ports[0]
  if (port !== undefined) authority.connect(port)
}
