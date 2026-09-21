const requiredNativeBackend = (): string => {
  const value = process.env['DINKSTER_NATIVE_BACKEND']
  if (!value) throw new Error('DINKSTER_NATIVE_BACKEND must identify the hosted native backend')
  return value.replace(/\/$/, '')
}

export default async function waitForNativeComposition(): Promise<void> {
  const backend = requiredNativeBackend()
  const url = `${backend}/api/composition`
  const deadline = Date.now() + 180_000
  let lastFailure = 'native backend did not answer'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) {
        lastFailure = `GET /api/composition returned ${response.status}`
      } else {
        const composition = await response.json() as {
          composing?: boolean
          packs?: Record<string, { state?: string; error?: string }>
        }
        const packs = Object.entries(composition.packs ?? {})
        if (!composition.composing && packs.length > 0) {
          const failed = packs.filter(([, pack]) => pack.state !== 'announced')
          if (failed.length > 0) {
            throw new Error(`native composition failed: ${JSON.stringify(Object.fromEntries(failed))}`)
          }
          return
        }
        lastFailure = 'native composition is still in progress'
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native composition failed:')) throw error
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`native composition did not settle within 180 seconds: ${lastFailure}`)
}
