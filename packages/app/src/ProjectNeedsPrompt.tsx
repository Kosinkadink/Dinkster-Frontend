import { createSignal, For, onCleanup, Show } from 'solid-js'
import type { PackPreparationProgress } from '@dinkster/client'
import { ProductErrorBanner, ProductNotice } from '@dinkster/ui'
import { PackPreparationStatus } from './PackPreparationStatus.js'
import type { AppState, ProjectNeedsReview, ProjectPackInstallationReview } from './app-state.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton } from './ProductControls.js'
import { ProductActionFooter, ProductField } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductListRow } from './ProductSurfaces.js'
import { useAppMessage } from './locale.js'
import { desktopFileBridge } from './desktop-bridge.js'

export function ProjectNeedsPrompt(props: { readonly app: AppState; readonly review: ProjectNeedsReview }) {
  const message = useAppMessage()
  const [busy, setBusy] = createSignal(false)
  const [uncertain, setUncertain] = createSignal(props.app.projectPackInstallations.has(props.review.backend))
  const [error, setError] = createSignal<string | undefined>(uncertain() ? message('search.installUnknown') : undefined)
  const [plan, setPlan] = createSignal<ProjectPackInstallationReview>()
  const [progress, setProgress] = createSignal<PackPreparationProgress>()
  const [preparing, setPreparing] = createSignal(false)
  const [applying, setApplying] = createSignal(false)
  const [scope, setScope] = createSignal<'every-project' | 'only-project'>()
  const projectScope = desktopFileBridge() !== undefined &&
    new URL(window.location.href).searchParams.get('dinksterProject') === props.review.project.id &&
    new URL(props.review.backend.baseUrl || '/', window.location.href).origin === window.location.origin
  const canConfirm = (): boolean => projectScope && plan()?.scope !== undefined && plan()?.installation.confirmation !== undefined
  let controller: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onCleanup(() => { disposed = true; controller?.abort(); clearTimeout(expiry) })
  const close = (): void => { if (props.app.projectNeedsReview.get() === props.review) props.app.projectNeedsReview.set(undefined) }
  const reviewInstallation = async (): Promise<void> => {
    if (busy() || uncertain() || projectScope && scope() === undefined) return
    controller?.abort()
    clearTimeout(expiry)
    controller = new AbortController()
    setBusy(true)
    setPreparing(true)
    setError(undefined)
    setPlan(undefined)
    setProgress(undefined)
    try {
      const result = await props.app.reviewProjectPackInstallation(props.review, controller.signal, (value) => {
        if (!disposed) setProgress(value)
      }, projectScope ? scope() : undefined)
      if (!disposed) {
        if (performance.now() >= result.expiresAt) throw new Error(message('search.installExpired'))
        setPlan(result)
        expiry = setTimeout(() => {
          setPlan(undefined)
          setError(message('search.installExpired'))
        }, Math.min(result.expiresAt - performance.now(), 2_147_483_647))
      }
    } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (!disposed) { setBusy(false); setPreparing(false) } }
  }
  const apply = async (): Promise<void> => {
    const approved = plan()
    if (busy() || uncertain() || !projectScope || approved?.scope !== scope() || approved?.installation.confirmation === undefined) return
    clearTimeout(expiry)
    if (performance.now() >= approved.expiresAt) { setPlan(undefined); setError(message('search.installExpired')); return }
    setBusy(true)
    setApplying(true)
    setError(undefined)
    try { await props.app.applyReviewedProjectPacks(props.review, approved) }
    catch (cause) {
      if (!disposed) {
        setUncertain(props.app.projectPackInstallations.has(props.review.backend))
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally { if (!disposed) { setPlan(undefined); setApplying(false); setBusy(false) } }
  }
  const enable = async (): Promise<void> => {
    if (busy() || uncertain()) return
    setBusy(true)
    setError(undefined)
    try { await props.app.enableReviewedProjectPacks(props.review) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const reviewAgain = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    try { await props.app.checkProjectNeeds(props.review.backend) }
    finally { setBusy(false) }
  }
  return <ModalSurface title={message('projectNeeds.title')} modalId="project-needs" dismissBlocked={busy() && !preparing()} onRequestClose={close}>
    <div class="projects-dialog" data-testid="project-needs">
      <Show when={error()}>{(detail) => <ProductErrorBanner onDismiss={() => setError(undefined)}>{detail()}</ProductErrorBanner>}</Show>
      <p>{props.review.project.name}</p>
      <Show when={props.review.enable.length > 0}>
        <p>{message('projectNeeds.enableDescription')}</p>
        <ul class="projects-dialog-list">
          <For each={props.review.enable}>{(pack) => <li><ProductListRow primary={pack}>
            <span>{props.review.needs.installed.find((entry) => entry.pack === pack)?.version ?? message('projectNeeds.unpinned')}</span>
          </ProductListRow></li>}</For>
        </ul>
      </Show>
      <Show when={props.review.changes.length > 0}>
        <ProductNotice>{message('projectNeeds.environmentChange')}</ProductNotice>
        <ul class="projects-dialog-list">
          <For each={props.review.changes}>{(pack) => <li><ProductListRow primary={pack.pack}>
            <span>{pack.version ?? message('projectNeeds.unpinned')}</span>
          </ProductListRow></li>}</For>
        </ul>
      </Show>
      <Show when={props.review.errors.length > 0}>
        <ProductNotice>{message('projectNeeds.unknown')}</ProductNotice>
        <ul class="projects-dialog-list"><For each={props.review.errors}>{(item) => <li>{item}</li>}</For></ul>
      </Show>
      <Show when={projectScope && props.review.changes.length > 0}>
        <ProductField controlId="project-installation-scope" label={message('projectNeeds.scope')} layout="stack">
          <ProductSelect<'every-project' | 'only-project' | undefined>
            id="project-installation-scope" ariaLabelledBy="project-installation-scope-label"
            selectedId={scope() ?? 'choose'} disabled={busy() || uncertain()}
            options={[
              { id: 'choose', label: message('projectNeeds.chooseScope'), value: undefined, disabled: true },
              { id: 'every-project', label: message('projectNeeds.everyProject'), value: 'every-project' },
              { id: 'only-project', label: message('projectNeeds.onlyProject'), value: 'only-project' },
            ]}
            onSelect={({ value }) => {
              clearTimeout(expiry)
              setPlan(undefined)
              setProgress(undefined)
              setError(undefined)
              setScope(value)
            }}
          />
        </ProductField>
      </Show>
      <Show when={preparing()}><p role="status"><PackPreparationStatus progress={progress()} /></p></Show>
      <Show when={plan()}>{(reviewed) => <>
        <Show when={!applying()}><ProductNotice>{message('projectNeeds.reviewOnly')}</ProductNotice></Show>
        <ProductNotice>{message(reviewed().scope === 'only-project' ? 'projectNeeds.impactIsolated'
          : reviewed().affectedProjects === null ? 'projectNeeds.impactUnknown'
            : reviewed().affectedProjects?.length === 0 ? 'projectNeeds.impactNone' : 'projectNeeds.impactShared')}</ProductNotice>
        <Show when={reviewed().scope !== 'only-project' && reviewed().affectedProjects}>{(projects) => <ul class="projects-dialog-list">
          <For each={projects()}>{(project) => <li><ProductListRow primary={project.name} /></li>}</For>
        </ul>}</Show>
        <pre class="node-install-review">{reviewed().installation.review}</pre>
      </>}</Show>
      <ProductActionFooter status={applying() ? <span role="status">{message('search.installWorking')}</span> : undefined}>
        <Show when={canConfirm()}>
          <ProductButton variant="primary" loading={busy()} disabled={busy() || uncertain()} onClick={() => { void apply() }}>{message('search.installConfirm')}</ProductButton>
        </Show>
        <Show when={props.review.enable.length > 0 && !canConfirm()}><ProductButton variant="primary" loading={busy()} disabled={busy() || uncertain()} onClick={() => { void enable() }}>{message('projectNeeds.enable')}</ProductButton></Show>
        <Show when={props.review.changes.length > 0 && !canConfirm()}><ProductButton disabled={busy() || uncertain() || projectScope && scope() === undefined} onClick={() => { void reviewInstallation() }}>{message('projectNeeds.reviewInstallation')}</ProductButton></Show>
        <ProductButton disabled={busy()} onClick={() => { void reviewAgain() }}>{message('projectNeeds.reviewAgain')}</ProductButton>
        <ProductButton disabled={busy() && !preparing()} onClick={close}>{message('common.close')}</ProductButton>
      </ProductActionFooter>
    </div>
  </ModalSurface>
}
