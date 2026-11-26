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
  await expect(panel.getByRole('heading', { name: 'Model folders', exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Mounts', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Default save folder', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('Added files are copied here')
  await expect(panel).toContainText('Reading, 136 of 212')
  await expect(panel).toContainText('Reading, 7 of 10')
  await expect(panel.getByRole('progressbar', { name: 'Reading, 7 of 10' })).toHaveAttribute('aria-valuenow', '0.25')
  await expect(panel).toContainText('8.0 MiB of 32 MiB read')
  await panel.screenshot({ path: testInfo.outputPath('storage-reading-dark.png') })
  await panel.locator('.storage-group-heading').last().getByRole('button', { name: 'Add', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Add a mount', exact: true })).toBeVisible()
  const folder = panel.getByRole('textbox', { name: 'Folder', exact: true })
  const name = panel.getByRole('textbox', { name: 'Name', exact: true })
  const saving = panel.getByRole('checkbox', { name: 'Allow saving to this folder' })
  await folder.fill('/archive/source-footage')
  await name.fill('footage')
  await expect(saving).toBeChecked()
  await panel.screenshot({ path: testInfo.outputPath('storage-add-mount-dark.png') })
  await page.route('**/api/mounts', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    expect(route.request().postDataJSON()).toMatchObject({ id: 'footage', path: '/archive/source-footage', mode: 'readwrite' })
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'not a directory: /archive/source-footage' }) })
  })
  await panel.getByRole('button', { name: 'Add a mount', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('not a directory: /archive/source-footage')
  await expect(folder).toHaveValue('/archive/source-footage')
  await expect(name).toHaveValue('footage')
  await expect(saving).toBeChecked()
  await panel.screenshot({ path: testInfo.outputPath('storage-mount-refusal-dark.png') })
  await saving.uncheck()
  await expect(saving).not.toBeChecked()
  await panel.screenshot({ path: testInfo.outputPath('storage-mount-read-only-dark.png') })
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Mounts', exact: true })).toBeVisible()
  await panel.locator('.storage-group-heading').first().getByRole('button', { name: 'Add', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Add a model folder', exact: true })).toBeVisible()
  const modelFolder = panel.getByRole('textbox', { name: 'Folder', exact: true })
  await modelFolder.fill('/mnt/big/models')
  await expect(panel.getByRole('combobox', { name: 'Used by' })).toHaveValue('always-on')
  const download = panel.getByRole('switch', { name: 'Download models into this folder' })
  await expect(download).not.toBeChecked()
  await panel.screenshot({ path: testInfo.outputPath('storage-add-model-dark.png') })
  await download.check()
  await panel.screenshot({ path: testInfo.outputPath('storage-add-model-download-dark.png') })
  await page.route('**/api/models/settings?*', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    expect(route.request().postDataJSON()).toMatchObject({ settings: { downloadLocation: 'models', locations: [expect.anything(), { id: 'models', path: '/mnt/big/models', mode: 'readwrite', visibility: 'always-on' }] } })
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Folder is unavailable' }) })
  })
  await panel.getByRole('button', { name: 'Add folder', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('Folder is unavailable')
  await expect(modelFolder).toHaveValue('/mnt/big/models')
  await expect(download).toBeChecked()
  await panel.screenshot({ path: testInfo.outputPath('storage-model-refusal-dark.png') })
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Model folders', exact: true })).toBeVisible()
})
