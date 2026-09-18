import { expect, test } from '@playwright/test'

const SHADER = `#version 300 es
#pragma passes 2
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_image1;
uniform sampler2D u_curve0;
uniform float u_float0;
uniform int u_int0;
uniform bool u_bool0;
uniform int u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
layout(location = 1) out vec4 fragColor1;
layout(location = 2) out vec4 fragColor2;
layout(location = 3) out vec4 fragColor3;
void main() {
  vec4 base = u_pass == 0 ? texture(u_image1, v_texCoord) : texture(u_image0, v_texCoord);
  float increment = u_float0 + float(u_int0) * 0.01 + (u_bool0 ? 0.02 : 0.0);
  fragColor0 = base + vec4(increment + (u_pass == 0 ? 0.0 : 0.05), 0.0, 0.0, 0.0);
  fragColor1 = vec4(texture(u_curve0, vec2(0.5, 0.5)).r);
  fragColor2 = vec4(float(u_int0) / 10.0, u_bool0 ? 0.5 : 0.0, float(u_pass) / 2.0, 1.0);
  fragColor3 = vec4(v_texCoord, 0.0, 1.0);
}`

test('browser runner renders sparse samplers, MRT, typed uniforms, curves, and multipass', async ({ page }) => {
  await page.goto('/src/glsl-shader-runner.ts')
  const result = await page.evaluate(async ({ shader }) => {
    const moduleUrl = '/src/glsl-shader-runner.ts'
    const { createGlslShaderRunner } = await import(/* @vite-ignore */ moduleUrl)
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const context = canvas.getContext('2d')!
    context.fillStyle = 'rgb(26, 51, 77)'
    context.fillRect(0, 0, 2, 2)
    const runner = createGlslShaderRunner()
    const state = {
      width: 2,
      height: 2,
      inputs: [{ name: 'u_image1', stream: 'glsl-input-u_image1' }],
      floats: { u_float0: 0.05 },
      ints: { u_int0: 3 },
      bools: { u_bool0: true },
      curves: { u_curve0: Array.from({ length: 256 }, (_value, index) => index / 255) },
    }
    const draw = (source: string, output: 0 | 1 | 2 | 3) => {
      const value = runner.render({ source, state, images: { u_image1: canvas }, output })
      return value.ok
        ? { ok: true as const, width: value.image.width, height: value.image.height, pixels: [...value.image.data] }
        : value
    }
    const rendered = [draw(shader, 0), draw(shader, 1), draw(shader, 2)]
    const malformed = draw('#version 300 es\nthis is not GLSL', 0)
    const outOfRange = draw(`#version 300 es
precision highp float;
layout(location = 0) out vec4 fragColor0;
layout(location = 1) out vec4 fragColor1;
layout(location = 2) out vec4 fragColor2;
layout(location = 3) out vec4 fragColor3;
void main() { fragColor0 = vec4(2.0); fragColor1 = vec4(0.0); fragColor2 = vec4(0.0); fragColor3 = vec4(0.0); }`, 0)
    runner.dispose()
    return { rendered, malformed, outOfRange }
  }, { shader: SHADER })

  expect(result.rendered).toHaveLength(3)
  for (const output of result.rendered) {
    expect(output).toMatchObject({ ok: true, width: 2, height: 2 })
  }
  const firstPixel = (result.rendered[0] as { readonly pixels: readonly number[] }).pixels.slice(0, 4)
  expect(firstPixel[0]).toBeGreaterThanOrEqual(88)
  expect(firstPixel[0]).toBeLessThanOrEqual(92)
  expect(firstPixel.slice(1)).toEqual([51, 77, 255])
  const curvePixel = (result.rendered[1] as { readonly pixels: readonly number[] }).pixels.slice(0, 4)
  expect(curvePixel).toEqual([128, 128, 128, 128])
  expect((result.rendered[2] as { readonly pixels: readonly number[] }).pixels.slice(0, 4)).toEqual([77, 128, 128, 255])
  expect(result.malformed).toEqual({
    ok: false,
    diagnostics: [expect.stringMatching(/ERROR|syntax|compile/i)],
  })
  expect(result.outOfRange).toEqual({
    ok: false,
    diagnostics: ['Preview output is outside display range [0, 1]; native output was not clamped'],
  })
})
