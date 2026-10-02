export type Program = { program: WebGLProgram; uniforms: Map<string, { location: WebGLUniformLocation; type: number }> }

export const vertexShader = `#version 300 es
in vec2 corner;
uniform mat3 toClip;
uniform mat3 toSource;
out vec2 sourceUV;
out vec2 docPosition;
void main() {
  vec3 clip = toClip * vec3(corner, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  docPosition = corner;
  sourceUV = (toSource * vec3(corner, 1.0)).xy;
}`

export function compile(gl: WebGL2RenderingContext, fragment: string, vertex = vertexShader): Program {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${gl.getShaderInfoLog(s)}\n${source.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')}`)
    return s
  }
  const program = gl.createProgram()!
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment))
  gl.bindAttribLocation(program, 0, 'corner')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  const uniforms: Program['uniforms'] = new Map()
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const info = gl.getActiveUniform(program, i)!
    uniforms.set(info.name.replace(/\[0\]$/, ''), { location: gl.getUniformLocation(program, info.name)!, type: info.type })
  }
  return { program, uniforms }
}

export type UniformValue = number | boolean | number[] | Float32Array | { texture?: WebGLTexture; unit: number; target?: number }

// Sets uniforms by their declared GLSL type; names the shader doesn't use (optimized away) are skipped.
export function use(gl: WebGL2RenderingContext, p: Program, uniforms: Record<string, UniformValue>) {
  gl.useProgram(p.program)
  for (const [name, value] of Object.entries(uniforms)) {
    const uniform = p.uniforms.get(name)
    if (!uniform) continue
    const { location, type } = uniform
    if (typeof value === 'object' && 'unit' in value) {
      if (value.texture) { gl.activeTexture(gl.TEXTURE0 + value.unit); gl.bindTexture(value.target ?? gl.TEXTURE_2D, value.texture) }
      gl.uniform1i(location, value.unit)
      continue
    }
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value
    switch (type) {
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_3D: gl.uniform1i(location, v as number); break
      case gl.UNSIGNED_INT: gl.uniform1ui(location, (v as number) >>> 0); break
      case gl.FLOAT: gl.uniform1f(location, v as number); break
      case gl.FLOAT_VEC2: gl.uniform2fv(location, v as number[]); break
      case gl.FLOAT_VEC3: gl.uniform3fv(location, v as number[]); break
      case gl.FLOAT_VEC4: gl.uniform4fv(location, v as number[]); break
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(location, false, v as number[]); break
      default: gl.uniform1fv(location, v as number[])
    }
  }
  gl.activeTexture(gl.TEXTURE0)
}

// 3×3 affine matrices, column-major as GLSL expects: [a, b, 0, c, d, 0, tx, ty, 1] maps (x, y) to (a x + c y + tx, b x + d y + ty).
export type Mat3 = number[]
export const identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]
export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0)
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) for (let k = 0; k < 3; k++) out[col * 3 + row] += a[k * 3 + row] * b[col * 3 + k]
  return out
}
export function invert(m: Mat3): Mat3 {
  const [a, b, , c, d, , tx, ty] = m
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return identity()
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det
  return [ia, ib, 0, ic, id, 0, -(ia * tx + ic * ty), -(ib * tx + id * ty), 1]
}
export const translate = (x: number, y: number): Mat3 => [1, 0, 0, 0, 1, 0, x, y, 1]
export const scale = (x: number, y = x): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1]
export const rotate = (radians: number): Mat3 => [Math.cos(radians), Math.sin(radians), 0, -Math.sin(radians), Math.cos(radians), 0, 0, 0, 1]
export const apply = (m: Mat3, x: number, y: number): [number, number] => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
export const chain = (...matrices: Mat3[]) => matrices.reduce((result, m) => multiply(result, m), identity())

export class Target {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
  constructor(private gl: WebGL2RenderingContext, public width: number, public height: number, readonly format: 'rgba8' | 'rgba16f', mipmaps = false) {
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texStorage2D(gl.TEXTURE_2D, mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1, format === 'rgba16f' ? gl.RGBA16F : gl.RGBA8, width, height)
    setSampling(gl, gl.LINEAR)
    this.framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0)
  }
  bind(clear = false) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.viewport(0, 0, this.width, this.height)
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT) }
  }
  dispose() { this.gl.deleteFramebuffer(this.framebuffer); this.gl.deleteTexture(this.texture) }
}

export function setSampling(gl: WebGL2RenderingContext, filter: number, wrap: number = gl.CLAMP_TO_EDGE) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
}

// A pool of same-size render targets, so a deep stack of folders doesn't allocate on every frame.
export class TargetPool {
  private free: Target[] = []
  constructor(private gl: WebGL2RenderingContext, private format: 'rgba8' | 'rgba16f') {}
  take(width: number, height: number) {
    const index = this.free.findIndex(t => t.width === width && t.height === height)
    const target = index >= 0 ? this.free.splice(index, 1)[0] : new Target(this.gl, width, height, this.format)
    target.bind(true)
    return target
  }
  give(target: Target) { this.free.push(target) }
  trim(width: number, height: number) { this.free = this.free.filter(t => (t.width === width && t.height === height) || (t.dispose(), false)) }
}
