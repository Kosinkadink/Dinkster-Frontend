/**
 * Read-only ComfyUI fixture for isolated renderer performance runs. It serves
 * the tracked schema catalog and enough queue/history/socket surface for the
 * app to reach a stable connected state without a live backend.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const portArg = process.argv.indexOf('--port')
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : 5439)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 5199 || port === 8765) {
  throw new Error('fixture --port must be a valid unprotected port')
}

const objectInfo = JSON.parse(
  readFileSync(new URL('../../core/fixtures/object_info.json', import.meta.url), 'utf8'),
)

const sendJson = (response, body) => {
  const encoded = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  })
  response.end(encoded)
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
  if (path === '/system_stats') return sendJson(response, { system: { os: 'isolated-perf' }, devices: [] })
  if (path === '/object_info') return sendJson(response, objectInfo)
  if (path === '/queue') return sendJson(response, { queue_running: [], queue_pending: [] })
  if (path === '/history') return sendJson(response, {})
  response.writeHead(404)
  response.end()
})

server.on('upgrade', (request, socket) => {
  if (new URL(request.url ?? '/', `http://${request.headers.host}`).pathname !== '/ws') {
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.on('error', () => {})
})

server.listen(port, '127.0.0.1', () => console.log(`isolated ComfyUI fixture listening on ${port}`))
