import { describe, expect, it } from 'vitest'
import { isSafeRevealPath, isTrustedDesktopIpc } from '../src/ipc-security.js'

describe('desktop IPC sender binding', () => {
  it('accepts only the expected top frame at the loopback app origin', () => {
    const sender = {}
    const frame = { url: 'http://127.0.0.1:5000/settings' }
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, frame)).toBe(true)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', {}, frame)).toBe(false)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, { url: frame.url })).toBe(false)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, { url: 'https://attacker.invalid' })).toBe(false)
  })
})

describe('desktop reveal path validation', () => {
  it('accepts bounded absolute paths and rejects renderer-controlled relative or nul paths', () => {
    const absolute = process.platform === 'win32' ? 'C:\\library\\output\\image.png' : '/library/output/image.png'
    expect(isSafeRevealPath(absolute)).toBe(true)
    expect(isSafeRevealPath('library/output/image.png')).toBe(false)
    expect(isSafeRevealPath(`${absolute}\0ignored`)).toBe(false)
    expect(isSafeRevealPath(`/${'a'.repeat(4096)}`)).toBe(false)
  })
})
