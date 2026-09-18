export interface ImageRaster {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type)
  const body = new Uint8Array(name.length + data.length)
  body.set(name)
  body.set(data, name.length)
  const out = new Uint8Array(12 + data.length)
  out.set(u32(data.length))
  out.set(body, 4)
  out.set(u32(crc32(body)), 8 + data.length)
  return out
}

async function transformBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  const copied = Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>
  // Start draining before write: browser stream backpressure may otherwise
  // leave writer.write waiting forever on larger decoder output.
  const result = new Response(stream.readable).arrayBuffer()
  await writer.write(copied)
  await writer.close()
  return new Uint8Array(await result)
}

export async function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4)
    throw new Error('invalid PNG dimensions')
  const rows = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1)
  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', await transformBytes(rows, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array())]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { png.set(part, offset); offset += part.length }
  return png
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export async function decodePng(bytes: Uint8Array): Promise<ImageRaster> {
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error('image editor currently requires PNG image bytes')
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = -1, offset = 8
  const idat: Uint8Array[] = []
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = header.getUint32(0); height = header.getUint32(4); bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!
      if (data[10] !== 0 || data[11] !== 0 || (interlace !== 0 && interlace !== 1)) throw new Error('unsupported PNG encoding')
    }
    if (type === 'PLTE') palette = data
    if (type === 'tRNS') transparency = data
    if (type === 'IDAT') idat.push(data)
    offset += length + 12
    if (type === 'IEND') break
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1
  const allowedDepth = colorType === 0
    ? [1, 2, 4, 8, 16].includes(bitDepth)
    : colorType === 3 ? [1, 2, 4, 8].includes(bitDepth) : [8, 16].includes(bitDepth)
  if (width < 1 || height < 1 || channels < 0 || !allowedDepth || (colorType === 3 && (!palette || palette.length % 3 !== 0)))
    throw new Error('unsupported PNG color format')
  const packed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0))
  let packedOffset = 0
  for (const part of idat) { packed.set(part, packedOffset); packedOffset += part.length }
  const filtered = await transformBytes(packed, new DecompressionStream('deflate'))
  const rgba = new Uint8ClampedArray(width * height * 4)
  const transparentView = transparency ? new DataView(transparency.buffer, transparency.byteOffset, transparency.byteLength) : undefined
  let filteredOffset = 0
  const passes = interlace === 0
    ? [[0, 0, 1, 1] as const]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const
  const sample = (row: Uint8Array, sampleIndex: number): number => {
    if (bitDepth === 16) return (row[sampleIndex * 2]! << 8) | row[sampleIndex * 2 + 1]!
    if (bitDepth === 8) return row[sampleIndex]!
    const bit = sampleIndex * bitDepth
    return (row[Math.floor(bit / 8)]! >>> (8 - bitDepth - (bit % 8))) & ((1 << bitDepth) - 1)
  }
  const byte = (value: number): number => bitDepth === 16 ? value >>> 8 : bitDepth === 8 ? value : Math.round(value * 255 / ((1 << bitDepth) - 1))
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width > startX ? Math.ceil((width - startX) / stepX) : 0
    const passHeight = height > startY ? Math.ceil((height - startY) / stepY) : 0
    if (passWidth === 0 || passHeight === 0) continue
    const stride = Math.ceil(passWidth * channels * bitDepth / 8)
    const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8))
    const raw = new Uint8Array(passHeight * stride)
    for (let y = 0; y < passHeight; y += 1) {
      if (filteredOffset + 1 + stride > filtered.length) throw new Error('invalid PNG raster length')
      const filter = filtered[filteredOffset++]!
      for (let x = 0; x < stride; x += 1) {
        const encoded = filtered[filteredOffset++]!
        const left = x >= bpp ? raw[y * stride + x - bpp]! : 0
        const up = y > 0 ? raw[(y - 1) * stride + x]! : 0
        const upperLeft = y > 0 && x >= bpp ? raw[(y - 1) * stride + x - bpp]! : 0
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : -1
        if (predictor < 0) throw new Error(`unsupported PNG filter ${filter}`)
        raw[y * stride + x] = (encoded + predictor) & 255
      }
      const row = raw.subarray(y * stride, (y + 1) * stride)
      for (let x = 0; x < passWidth; x += 1) {
        const samples = Array.from({ length: channels }, (_, channel) => sample(row, x * channels + channel))
        let red = 0, green = 0, blue = 0, alpha = 255
        if (colorType === 0) {
          red = green = blue = byte(samples[0]!)
          if (transparentView && samples[0] === transparentView.getUint16(0)) alpha = 0
        } else if (colorType === 2) {
          red = byte(samples[0]!); green = byte(samples[1]!); blue = byte(samples[2]!)
          if (transparentView && samples.every((value, channel) => value === transparentView.getUint16(channel * 2))) alpha = 0
        } else if (colorType === 3) {
          const index = samples[0]!
          if (!palette || index * 3 + 2 >= palette.length) throw new Error('invalid PNG palette index')
          red = palette[index * 3]!; green = palette[index * 3 + 1]!; blue = palette[index * 3 + 2]!; alpha = transparency?.[index] ?? 255
        } else if (colorType === 4) {
          red = green = blue = byte(samples[0]!); alpha = byte(samples[1]!)
        } else {
          red = byte(samples[0]!); green = byte(samples[1]!); blue = byte(samples[2]!); alpha = byte(samples[3]!)
        }
        const pixel = ((startY + y * stepY) * width + startX + x * stepX) * 4
        rgba.set([red, green, blue, alpha], pixel)
      }
    }
  }
  if (filteredOffset !== filtered.length) throw new Error('invalid PNG raster length')
  return { width, height, rgba }
}
