import { Show, createSignal } from 'solid-js'
import { ProductButton, ProductCheckbox, ProductSecretDialog, ProductSection, ProductToast } from '../src/index.js'

export function SecretsGallery() {
  const [open, setOpen] = createSignal(false)
  const [admin, setAdmin] = createSignal(false)
  const [reject, setReject] = createSignal(false)
  const [notification, setNotification] = createSignal<{ message: string }>()
  return (
    <ProductSection title="Set a secret">
      <p class="dinkster-description">The host form never reads an existing credential. This gallery uses a simulated save and stores no value.</p>
      <ProductCheckbox label="Administrator" checked={admin()} onChange={(event) => setAdmin(event.currentTarget.checked)} />
      <ProductCheckbox label="Reject the next secret save" checked={reject()} onChange={(event) => setReject(event.currentTarget.checked)} />
      <ProductButton onClick={() => setOpen(true)}>Set caption-service</ProductButton>
      <Show when={open()}>
        <ProductSecretDialog name="caption-service" contextKey="gallery-account-on-this-host" canManageDeployment={admin()}
          onSave={async () => {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 600))
            if (reject()) {
              setReject(false)
              return 'Secret access is not permitted.'
            }
          }}
          onCancel={() => setOpen(false)}
          onSaved={() => {
            setOpen(false)
            setNotification({ message: 'Secret set' })
          }} />
      </Show>
      <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
    </ProductSection>
  )
}
