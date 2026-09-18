import { onCleanup, onMount } from 'solid-js'

export function useAssetDecisionViewport(target: () => HTMLElement | undefined): void {
  onMount(() => {
    const fit = (): void => {
      const dialog = target()?.closest<HTMLDialogElement>('dialog')
      if (!dialog) return
      const zoom = Math.max(1, Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1)
      dialog.style.maxHeight = `${Math.max(240, window.innerHeight / zoom - 16)}px`
      dialog.style.maxWidth = `${Math.max(240, window.innerWidth / zoom - 16)}px`
    }
    const observer = new MutationObserver(fit)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', fit)
    fit()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
    })
  })
}
