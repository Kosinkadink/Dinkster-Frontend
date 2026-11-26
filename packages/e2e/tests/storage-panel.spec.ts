import { expect, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

test('Storage shows engine file and byte reading progress on model folders and mounts', async ({ page }, testInfo) => {
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((row) => row.protocol === 'dinkster')!
    if (backend.protocol !== 'dinkster') throw new Error('Native backend missing')
    const mounts = [
      { id: 'models-checkpoint', path: '/home/kosin/ComfyUI/models/checkpoints', mode: 'read' as const, state: 'scanning', source: 'shared-models', kind: 'model/checkpoint', scanProgress: { filesDone: 136, filesTotal: 212, bytesDone: 61 * 1024 ** 3, bytesTotal: 96 * 1024 ** 3, elapsedSeconds: 4 } },
      { id: 'input', path: '/home/kosin/Dinkster/Portraits/input', mode: 'readwrite' as const, state: 'scanning', scanProgress: { filesDone: 7, filesTotal: 10, bytesDone: 8 * 1024 ** 2, bytesTotal: 32 * 1024 ** 2, elapsedSeconds: 2 } },
    ]
    const location = { id: 'ComfyUI', path: '/home/kosin/ComfyUI/models', mode: 'read' as const, visibility: 'default-on' as const }
    backend.connection.fetchMountSettings = async () => ({ mounts, mountChangesAllowed: true })
    backend.connection.fetchMountLocations = async () => ({ mounts, importMount: 'input' })
    backend.connection.fetchModelSettings = async () => ({ settings: { version: 1, locations: [location], downloadLocation: null },
      locations: [{ ...location, enabled: true, active: true, mounts: ['models-checkpoint'] }], revision: 'reading-fixture', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [] })
  })
  await page.getByTestId('storage-sidebar-toggle').click()
  const panel = page.getByTestId('storage-panel')
  await expect(panel).toContainText('Reading, 136 of 212')
  await expect(panel).toContainText('Reading, 7 of 10')
  await expect(panel.getByRole('progressbar', { name: 'Reading, 7 of 10' })).toHaveAttribute('aria-valuenow', '0.25')
  await expect(panel).toContainText('8.0 MiB of 32 MiB read')
  await panel.screenshot({ path: testInfo.outputPath('storage-reading-dark.png') })
})
