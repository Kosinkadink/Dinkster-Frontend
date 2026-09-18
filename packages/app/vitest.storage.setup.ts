// Node >= 25 defines global localStorage/sessionStorage getters that return
// a non-functional stub unless --localstorage-file is set. Vitest's happy-dom
// environment populates the same global object (window === globalThis), so
// the stub shadows the DOM Storage and every test touching web storage
// fails. Install an in-memory Storage only when the global one is broken.
// Like real Storage, items are enumerable own properties (so
// Object.keys(localStorage) lists them) while methods live on the prototype.
class MemoryStorage implements Storage {
  [name: string]: unknown
  get length(): number { return Object.keys(this).length }
  clear(): void { for (const key of Object.keys(this)) delete this[key] }
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this, String(key)) ? String(this[String(key)]) : null
  }
  key(index: number): string | null { return Object.keys(this)[index] ?? null }
  removeItem(key: string): void { delete this[String(key)] }
  setItem(key: string, value: string): void { this[String(key)] = String(value) }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const current = (globalThis as Record<string, unknown>)[name] as { clear?: unknown } | undefined
  if (typeof current?.clear !== 'function') {
    Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true })
  }
}

export {}
