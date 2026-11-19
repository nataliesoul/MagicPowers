/**
 * MagicPowersEffectsLib — procedural VFX building blocks shared by every power.
 *
 * Owns: additive material cloning, QuadBatch (one draw call for N camera-facing quads or ribbon
 *       segments, rebuilt per frame via MeshBuilder), ParticlePool (simple CPU particles drawn into
 *       a QuadBatch), SphereVisual (built-in sphere mesh + unlit additive material), arc/noise math,
 *       SurfaceProbe (WorldQuery hit-test with an editor-safe fallback) and small easing helpers.
 * Expects: an EffectsContext (materials, textures, camera) from MagicPowersMain.
 * Must not: know about gestures or spell state — powers compose these primitives.
 *
 * Draw-call budget: each QuadBatch is exactly one RenderMeshVisual. Powers keep 3-5 batches alive,
 * which keeps the whole experience at well under 20 draw calls on Specs.
 */

import { EffectsContext } from "./MagicPowersTypes"

// ─── Math helpers ────────────────────────────────────────────────────────────

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Frame-rate independent exponential approach: moves `current` towards `target` at `rate` per second. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

export function approachVec(current: vec3, target: vec3, rate: number, dt: number): vec3 {
  return vec3.lerp(current, target, 1 - Math.exp(-rate * dt))
}

/** Deterministic hash in [-1, 1]. */
export function hash1(x: number): number {
  const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

/** Time-stepped value noise: re-rolls `hz` times per second and interpolates between rolls. */
export function flickerNoise(i: number, seed: number, t: number, hz: number): number {
  const k = Math.floor(t * hz)
  const f = t * hz - k
  const a = hash1(i * 7.13 + k * 0.371 + seed * 53.7)
  const b = hash1(i * 7.13 + (k + 1) * 0.371 + seed * 53.7)
  return lerp(a, b, f)
}

export function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

export function randomUnitVector(): vec3 {
  const z = randRange(-1, 1)
  const a = randRange(0, Math.PI * 2)
  const r = Math.sqrt(1 - z * z)
  return new vec3(r * Math.cos(a), r * Math.sin(a), z)
}

/** Two unit vectors perpendicular to `dir`. */
export function perpendicularBasis(dir: vec3): { n1: vec3; n2: vec3 } {
  const helper = Math.abs(dir.y) < 0.9 ? vec3.up() : vec3.right()
  const n1 = dir.cross(helper).normalize()
  const n2 = dir.cross(n1).normalize()
  return { n1, n2 }
}

export function tint(c: vec4, mul: number, alpha?: number): vec4 {
  return new vec4(c.x * mul, c.y * mul, c.z * mul, alpha === undefined ? c.w : alpha)
}

// ─── Materials ───────────────────────────────────────────────────────────────

/** Clone an additive glow material (no depth write, two-sided) with an optional texture + tint. */
export function cloneGlowMaterial(base: Material, texture: Texture | null, color: vec4): Material {
  const m = base.clone()
  const pass = m.mainPass
  if (texture) pass.baseTex = texture
  pass.baseColor = color
  pass.blendMode = BlendMode.Add
  pass.depthWrite = false
  pass.depthTest = true
  pass.twoSided = true
  return m
}

// ─── QuadBatch: N quads, one draw call ───────────────────────────────────────

const FLOATS_PER_VERT = 9 // position(3) + color(4) + uv(2)
const FLOATS_PER_QUAD = FLOATS_PER_VERT * 4

export class QuadBatch {
  readonly obj: SceneObject
  readonly capacity: number
  private builder: MeshBuilder
  private rmv: RenderMeshVisual
  private verts: number[]
  private count = 0
  private highWater = 0

  constructor(parent: SceneObject, name: string, material: Material, capacity: number) {
    this.capacity = capacity
    this.obj = global.scene.createSceneObject(name)
    this.obj.setParent(parent)
    const t = this.obj.getTransform()
    t.setWorldPosition(vec3.zero())
    t.setWorldRotation(quat.quatIdentity())
    t.setWorldScale(vec3.one())

    this.builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "color", components: 4 },
      { name: "texture0", components: 2 },
    ])
    this.builder.topology = MeshTopology.Triangles
    this.builder.indexType = MeshIndexType.UInt16

    this.verts = new Array<number>(capacity * FLOATS_PER_QUAD).fill(0)
    this.builder.appendVerticesInterleaved(this.verts)
    const idx: number[] = []
    for (let i = 0; i < capacity; i++) {
      const b = i * 4
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    this.builder.appendIndices(idx)

    this.rmv = this.obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    this.rmv.mesh = this.builder.getMesh()
    this.rmv.mainMaterial = material
    this.builder.updateMesh()
  }

  begin(): void {
    this.count = 0
  }

  private writeVert(o: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number, u: number, v: number): void {
    const d = this.verts
    d[o] = x
    d[o + 1] = y
    d[o + 2] = z
    d[o + 3] = r
    d[o + 4] = g
    d[o + 5] = b
    d[o + 6] = a
    d[o + 7] = u
    d[o + 8] = v
  }

  /**
   * Camera-facing (or any basis) quad: center c, half-extents hw along r and hh along u.
   * Colour is premultiplied by alpha so additive fading works with any blend setup.
   */
  quad(c: vec3, r: vec3, u: vec3, hw: number, hh: number, col: vec4): void {
    if (this.count >= this.capacity) return
    const a = clamp01(col.w)
    const cr = col.x * a
    const cg = col.y * a
    const cb = col.z * a
    const rx = r.x * hw, ry = r.y * hw, rz = r.z * hw
    const ux = u.x * hh, uy = u.y * hh, uz = u.z * hh
    const o = this.count * FLOATS_PER_QUAD
    this.writeVert(o, c.x - rx - ux, c.y - ry - uy, c.z - rz - uz, cr, cg, cb, a, 0, 0)
    this.writeVert(o + 9, c.x + rx - ux, c.y + ry - uy, c.z + rz - uz, cr, cg, cb, a, 1, 0)
    this.writeVert(o + 18, c.x + rx + ux, c.y + ry + uy, c.z + rz + uz, cr, cg, cb, a, 1, 1)
    this.writeVert(o + 27, c.x - rx + ux, c.y - ry + uy, c.z - rz + uz, cr, cg, cb, a, 0, 1)
    this.count++
  }

  /** Quad rotated by `angle` radians around the view axis. */
  quadRotated(c: vec3, r: vec3, u: vec3, hw: number, hh: number, col: vec4, angle: number): void {
    const cs = Math.cos(angle)
    const sn = Math.sin(angle)
    const r2 = new vec3(r.x * cs + u.x * sn, r.y * cs + u.y * sn, r.z * cs + u.z * sn)
    const u2 = new vec3(-r.x * sn + u.x * cs, -r.y * sn + u.y * cs, -r.z * sn + u.z * cs)
    this.quad(c, r2, u2, hw, hh, col)
  }

  /** Ribbon segment from p0 to p1, `width` cm wide, always facing the camera position. UV u runs along the segment. */
  segment(p0: vec3, p1: vec3, width: number, col: vec4, camPos: vec3): void {
    if (this.count >= this.capacity) return
    const dir = p1.sub(p0)
    const mid = p0.add(p1).uniformScale(0.5)
    const toCam = camPos.sub(mid)
    let side = dir.cross(toCam)
    const len = side.length
    if (len < 1e-5) return
    side = side.uniformScale(width * 0.5 / len)
    const a = clamp01(col.w)
    const cr = col.x * a
    const cg = col.y * a
    const cb = col.z * a
    const o = this.count * FLOATS_PER_QUAD
    this.writeVert(o, p0.x - side.x, p0.y - side.y, p0.z - side.z, cr, cg, cb, a, 0, 0)
    this.writeVert(o + 9, p1.x - side.x, p1.y - side.y, p1.z - side.z, cr, cg, cb, a, 1, 0)
    this.writeVert(o + 18, p1.x + side.x, p1.y + side.y, p1.z + side.z, cr, cg, cb, a, 1, 1)
    this.writeVert(o + 27, p0.x + side.x, p0.y + side.y, p0.z + side.z, cr, cg, cb, a, 0, 1)
    this.count++
  }

  /** Upload the frame's quads. Unused slots are collapsed to zero-area so they never render. */
  end(): void {
    if (this.count < this.highWater) {
      for (let i = this.count * FLOATS_PER_QUAD; i < this.highWater * FLOATS_PER_QUAD; i++) this.verts[i] = 0
    }
    this.highWater = this.count
    const n = this.builder.getVerticesCount()
    if (n > 0) this.builder.eraseVertices(0, n)
    this.builder.appendVerticesInterleaved(this.verts)
    if (this.builder.isValid()) this.builder.updateMesh()
    this.rmv.enabled = this.count > 0
  }

  get activeCount(): number {
    return this.count
  }

  setEnabled(enabled: boolean): void {
    this.rmv.enabled = enabled
  }

  destroy(): void {
    if (!isNull(this.obj)) this.obj.destroy()
  }
}

// ─── Particles ───────────────────────────────────────────────────────────────

export interface Particle {
  pos: vec3
  vel: vec3
  age: number
  life: number
  size: number
  sizeEnd: number
  color: vec4
  spin: number
  angle: number
  drag: number
  gravity: number
  /** Optional extra curl noise strength (cm/s). */
  turbulence: number
  seed: number
}

export class ParticlePool {
  readonly particles: Particle[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get count(): number {
    return this.particles.length
  }

  spawn(p: Partial<Particle> & { pos: vec3 }): Particle | null {
    if (this.particles.length >= this.capacity) {
      // recycle the oldest particle so bursts never starve the emitter
      this.particles.shift()
    }
    const part: Particle = {
      pos: p.pos,
      vel: p.vel ?? vec3.zero(),
      age: 0,
      life: p.life ?? 1,
      size: p.size ?? 1,
      sizeEnd: p.sizeEnd ?? 0,
      color: p.color ?? new vec4(1, 1, 1, 1),
      spin: p.spin ?? 0,
      angle: p.angle ?? randRange(0, Math.PI * 2),
      drag: p.drag ?? 0,
      gravity: p.gravity ?? 0,
      turbulence: p.turbulence ?? 0,
      seed: Math.random() * 1000,
    }
    this.particles.push(part)
    return part
  }

  update(dt: number, time: number): void {
    const arr = this.particles
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i]
      p.age += dt
      if (p.age >= p.life) {
        arr.splice(i, 1)
        continue
      }
      if (p.turbulence > 0) {
        const tx = flickerNoise(1, p.seed, time, 6) * p.turbulence
        const ty = flickerNoise(2, p.seed, time, 6) * p.turbulence
        const tz = flickerNoise(3, p.seed, time, 6) * p.turbulence
        p.vel = new vec3(p.vel.x + tx * dt, p.vel.y + ty * dt, p.vel.z + tz * dt)
      }
      if (p.gravity !== 0) p.vel = new vec3(p.vel.x, p.vel.y - p.gravity * dt, p.vel.z)
      if (p.drag > 0) p.vel = p.vel.uniformScale(Math.max(0, 1 - p.drag * dt))
      p.pos = p.pos.add(p.vel.uniformScale(dt))
      p.angle += p.spin * dt
    }
  }

  clear(): void {
    this.particles.length = 0
  }

  /** Draw every particle as a camera-facing quad. `fade` scales alpha (e.g. tracking confidence). */
  draw(batch: QuadBatch, camRight: vec3, camUp: vec3, fade = 1): void {
    for (const p of this.particles) {
      const t = p.age / p.life
      const alpha = smoothstep(0, 0.12, t) * (1 - t) * (1 - t) * fade
      const size = lerp(p.size, p.sizeEnd, t)
      batch.quadRotated(p.pos, camRight, camUp, size * 0.5, size * 0.5, tint(p.color, 1, p.color.w * alpha), p.angle)
    }
  }
}

// ─── Spheres ─────────────────────────────────────────────────────────────────

export class SphereVisual {
  readonly obj: SceneObject
  readonly material: Material
  private rmv: RenderMeshVisual
  private meshRadius: number
  private radius = 1

  constructor(parent: SceneObject, name: string, ctx: EffectsContext, color: vec4) {
    this.obj = global.scene.createSceneObject(name)
    this.obj.setParent(parent)
    this.rmv = this.obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    this.rmv.mesh = ctx.sphereMesh
    this.material = cloneGlowMaterial(ctx.solidMaterial, null, color)
    this.rmv.mainMaterial = this.material
    const ext = ctx.sphereMesh.aabbMax
    this.meshRadius = Math.max(0.01, Math.max(ext.x, Math.max(ext.y, ext.z)))
    this.setRadius(1)
  }

  setRadius(r: number): void {
    this.radius = r
    const s = r / this.meshRadius
    this.obj.getTransform().setWorldScale(new vec3(s, s, s))
  }

  getRadius(): number {
    return this.radius
  }

  setPosition(p: vec3): void {
    this.obj.getTransform().setWorldPosition(p)
  }

  /** Colour with alpha premultiplied for additive blending. */
  setColor(c: vec4): void {
    this.material.mainPass.baseColor = new vec4(c.x * c.w, c.y * c.w, c.z * c.w, c.w)
  }

  setVisible(v: boolean): void {
    this.rmv.enabled = v
  }

  destroy(): void {
    if (!isNull(this.obj)) this.obj.destroy()
  }
}

// ─── Lightning arcs ──────────────────────────────────────────────────────────

/**
 * Fills `out` with `segments + 1` points of a jagged arc from a to b.
 * amplitude: max perpendicular displacement (cm). seed: per-arc identity. hz: flicker rate.
 */
export function buildArc(a: vec3, b: vec3, segments: number, amplitude: number, seed: number, time: number, hz: number, out: vec3[]): void {
  const dir = b.sub(a)
  const len = dir.length
  if (len < 1e-4) {
    out.length = 0
    return
  }
  const d = dir.uniformScale(1 / len)
  const basis = perpendicularBasis(d)
  out.length = 0
  for (let i = 0; i <= segments; i++) {
    const s = i / segments
    const env = Math.sin(s * Math.PI)
    const j1 = flickerNoise(i, seed, time, hz) + 0.5 * flickerNoise(i + 100, seed * 1.3, time, hz * 1.7)
    const j2 = flickerNoise(i + 50, seed, time, hz) + 0.5 * flickerNoise(i + 150, seed * 1.7, time, hz * 1.7)
    const off = basis.n1.uniformScale(j1 * amplitude * env).add(basis.n2.uniformScale(j2 * amplitude * env))
    out.push(a.add(d.uniformScale(s * len)).add(off))
  }
}

/** Draw an arc as a glow ribbon + a thin core ribbon. */
export function drawArc(points: vec3[], glow: QuadBatch, core: QuadBatch, glowWidth: number, coreWidth: number, glowColor: vec4, coreColor: vec4, camPos: vec3): void {
  for (let i = 0; i + 1 < points.length; i++) {
    glow.segment(points[i], points[i + 1], glowWidth, glowColor, camPos)
    core.segment(points[i], points[i + 1], coreWidth, coreColor, camPos)
  }
}

// ─── Surface probing (WorldQuery with fallback) ──────────────────────────────

export class SurfaceProbe {
  private session: HitTestSession | null = null
  private available = false

  constructor() {
    try {
      const mod = require("LensStudio:WorldQueryModule") as WorldQueryModule
      const options = HitTestSessionOptions.create()
      options.filter = true
      this.session = mod.createHitTestSessionWithOptions(options)
      this.session.start()
      this.available = true
    } catch (e) {
      this.available = false
      this.session = null
    }
  }

  get isAvailable(): boolean {
    return this.available
  }

  /** Async hit test; callback receives the hit position + normal, or null when nothing was hit (or unavailable). */
  probe(from: vec3, to: vec3, cb: (hit: { position: vec3; normal: vec3 } | null) => void): void {
    if (!this.available || !this.session) {
      cb(null)
      return
    }
    try {
      this.session.hitTest(from, to, (hit: WorldQueryHitTestResult) => {
        if (hit === null || hit === undefined) cb(null)
        else cb({ position: hit.position, normal: hit.normal })
      })
    } catch (e) {
      cb(null)
    }
  }

  destroy(): void {
    if (this.session) {
      try {
        this.session.stop()
      } catch (e) {
        // ignore
      }
    }
    this.session = null
  }
}

/** Camera basis for billboarding. `look` is the direction the camera looks along. */
export function cameraBasis(cam: Transform): { pos: vec3; right: vec3; up: vec3; look: vec3 } {
  return { pos: cam.getWorldPosition(), right: cam.right, up: cam.up, look: cam.back }
}
