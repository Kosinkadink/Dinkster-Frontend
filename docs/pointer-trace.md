# Pointer trace

The canvas pointer trace records raw pointer events and gesture transitions to
diagnose platform-specific release sequences. It is disabled by default and
keeps only the newest 512 entries.

To enable it before the canvas is constructed, run this in the browser console
and reload:

```js
localStorage.setItem('dinkster.pointerTrace', '1')
location.reload()
```

Reproduce the failed gesture, then dump a copy of the trace:

```js
copy(window.__dinksterPointerTrace.dump())
```

Paste the copied array into the bug report. The console API also supports
`enable()`, `disable()`, and `clear()` without a reload. Remove the stored flag
and reload when tracing is no longer needed:

```js
localStorage.removeItem('dinkster.pointerTrace')
location.reload()
```
