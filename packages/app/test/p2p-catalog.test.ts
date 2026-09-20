import { readdirSync } from 'node:fs'
import { setLocale, t } from '@dinkster/core'
import { afterEach, describe, expect, it } from 'vitest'
import english from '../src/locales/en.json'
import chinese from '../src/locales/zh.json'
import '../src/locale.js'

afterEach(() => setLocale('en'))

const p2pEnglish = Object.fromEntries(Object.entries(english).filter(([key]) => key.startsWith('p2p.')))
const placeholders = (message: string): string[] => [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)(?=,|\})/g)]
  .map((match) => match[1]!)
  .sort()

describe('shipped message catalogs', () => {
  it('ships only the approved English and Chinese catalogs', () => {
    expect(readdirSync(new URL('../src/locales', import.meta.url)).sort()).toEqual(['en.json', 'zh.json'])
  })

  it('keeps the Chinese catalog complete with matching placeholders', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      expect(placeholders(chinese[key]), key).toEqual(placeholders(english[key]))
    }
  })

  it('uses base-language and English fallback', () => {
    expect(Object.keys(p2pEnglish)).toHaveLength(111)
    setLocale('zh-CN')
    expect(t('p2p.title')).toBe('P2P \u4f20\u8f93')
    setLocale('fr')
    expect(t('p2p.title')).toBe('P2P transfers')
  })
})

describe('shared P2P messages', () => {
  it('keeps the complete English P2P catalog', () => {
    expect(Object.keys(p2pEnglish)).toHaveLength(111)
  })
  it('directs read-only users to an operator startup override without granting write access', () => {
    expect(english['p2p.readOnly']).toContain('--disable-p2p')
    expect(english['p2p.readOnly']).toContain('without granting settings-write access')
    expect(chinese['p2p.readOnly']).toContain('--disable-p2p')
  })
  it('preserves the required disclosure exactly', () => {
    expect(english['p2p.disclosure']).toBe('Other peers can learn your IP address and that your device is requesting or sharing a particular model digest.')
  })
  it('describes one sharing toggle with seeding state and distinguishes disk from rate limits', () => {
    expect(english['p2p.sharingHelpControl']).toContain('Controls peer downloads and background seeding together.')
    expect(english['p2p.sharingHelpOff']).toContain('Current seeding state: Off.')
    expect(english['p2p.sharingHelpMixed']).toContain('do not match')
    expect(english['p2p.sharingHelpMixed']).toContain('Turning sharing on enables both.')
    expect(english['p2p.sharingHelpMixed']).not.toContain('Peer downloads are on')
    expect(english['p2p.sharingHelpMixed']).not.toContain('background seeding is off')
    expect(english['p2p.sharingHelpOn']).toContain('Current seeding state: On.')
    expect(english['p2p.stagingHelp']).toContain('Zero denies new P2P disk growth; it is not unlimited.')
    expect(english['p2p.capsHelp']).toContain('0 for unlimited')
    expect(english['p2p.panelDescription']).not.toMatch(/consent|opt-in/i)
    expect(english['p2p.sharingLegend']).toBe('Sharing controls')
  })
})
