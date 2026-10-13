import * as THREE from 'three';

const CELL = 4;
const EPS = 1e-6;

type Point = { x: number; z: number };
export interface PropRayHit { dist: number; nx: number; nz: number }

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function convexHull(points: Point[]): Point[] {
  const sorted = points.sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, all) => !i || Math.abs(p.x - all[i - 1].x) > EPS || Math.abs(p.z - all[i - 1].z) > EPS);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= EPS) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= EPS) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function closestOnEdge(x: number, z: number, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / Math.max(EPS, dx * dx + dz * dz), 0, 1);
  return { x: a.x + dx * t, z: a.z + dz * t };
}

/** The very same local bounds and matrix used to draw a prop component. */
export class PropCollider {
  readonly bounds: THREE.Box3;
  readonly footprint: Point[];
  readonly inverse: THREE.Matrix4;
  private readonly inverseDirection: THREE.Matrix3;
  private readonly normalMatrix: THREE.Matrix3;
  private readonly localOrigin = new THREE.Vector3();
  private readonly localDirection = new THREE.Vector3();
  private readonly localNormal = new THREE.Vector3();

  constructor(
    readonly matrix: THREE.Matrix4,
    readonly localBounds: THREE.Box3,
    readonly owner: string,
    readonly name: string,
  ) {
    this.inverse = matrix.clone().invert();
    this.inverseDirection = new THREE.Matrix3().setFromMatrix4(this.inverse);
    this.normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    this.bounds = localBounds.clone().applyMatrix4(matrix);
    const corners: Point[] = [];
    const p = new THREE.Vector3();
    for (const x of [localBounds.min.x, localBounds.max.x]) {
      for (const y of [localBounds.min.y, localBounds.max.y]) {
        for (const z of [localBounds.min.z, localBounds.max.z]) {
          p.set(x, y, z).applyMatrix4(matrix);
          corners.push({ x: p.x, z: p.z });
        }
      }
    }
    this.footprint = convexHull(corners);
  }

  private circleContact(x: number, z: number, radius: number) {
    const b = this.bounds;
    if (x + radius < b.min.x || x - radius > b.max.x || z + radius < b.min.z || z - radius > b.max.z) return null;
    let inside = true;
    let nearest = Infinity;
    let px = 0, pz = 0, nx = 0, nz = 0;
    const point = { x, z };
    for (let i = 0; i < this.footprint.length; i++) {
      const a = this.footprint[i];
      const edge = this.footprint[(i + 1) % this.footprint.length];
      if (cross(a, edge, point) < -EPS) inside = false;
      const closest = closestOnEdge(x, z, a, edge);
      const d2 = (x - closest.x) ** 2 + (z - closest.z) ** 2;
      if (d2 < nearest) {
        nearest = d2;
        px = closest.x; pz = closest.z;
        const len = Math.hypot(edge.x - a.x, edge.z - a.z);
        nx = (edge.z - a.z) / len;
        nz = -(edge.x - a.x) / len;
      }
    }
    if (!inside && nearest > radius * radius) return null;
    if (!inside && nearest > EPS * EPS) {
      const distance = Math.sqrt(nearest);
      nx = (x - px) / distance;
      nz = (z - pz) / distance;
    }
    return { x: px + nx * (radius + EPS), z: pz + nz * (radius + EPS) };
  }

  overlapsCircle(x: number, z: number, radius: number, feet = 0, height = 1.8) {
    if (feet >= this.bounds.max.y - EPS || feet + height <= this.bounds.min.y + EPS) return false;
    return this.circleContact(x, z, radius) !== null;
  }

  resolveCircle(pos: THREE.Vector3, radius: number, height: number) {
    if (pos.y >= this.bounds.max.y - EPS || pos.y + height <= this.bounds.min.y + EPS) return;
    const contact = this.circleContact(pos.x, pos.z, radius);
    if (contact) { pos.x = contact.x; pos.z = contact.z; }
  }

  rayHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): PropRayHit | null {
    const o = this.localOrigin.copy(origin).applyMatrix4(this.inverse);
    // Do not normalise after inverse scale: t must remain a world distance.
    const d = this.localDirection.copy(dir).applyMatrix3(this.inverseDirection);
    let near = 0;
    let far = maxDistance;
    this.localNormal.set(0, 0, 0);
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[axis]) < EPS) {
        if (o[axis] < this.localBounds.min[axis] || o[axis] > this.localBounds.max[axis]) return null;
        continue;
      }
      let entry = (this.localBounds.min[axis] - o[axis]) / d[axis];
      let exit = (this.localBounds.max[axis] - o[axis]) / d[axis];
      if (entry > exit) [entry, exit] = [exit, entry];
      if (entry > near) {
        near = entry;
        this.localNormal.set(0, 0, 0);
        this.localNormal[axis] = d[axis] > 0 ? -1 : 1;
      }
      far = Math.min(far, exit);
      if (near > far) return null;
    }
    if (far < 0 || near > maxDistance) return null;
    const normal = this.localNormal.applyMatrix3(this.normalMatrix).normalize();
    return { dist: near, nx: normal.x, nz: normal.z };
  }
}

/** Static broad phase: detailed furniture only tests nearby components. */
export class PropCollisionIndex {
  private readonly cells = new Map<string, PropCollider[]>();
  private readonly candidates = new Set<PropCollider>();

  add(matrix: THREE.Matrix4, localBounds: THREE.Box3, owner: string, name: string): PropCollider {
    const collider = new PropCollider(matrix.clone(), localBounds.clone(), owner, name);
    const b = collider.bounds;
    for (let z = Math.floor(b.min.z / CELL); z <= Math.floor(b.max.z / CELL); z++) {
      for (let x = Math.floor(b.min.x / CELL); x <= Math.floor(b.max.x / CELL); x++) {
        const key = `${x}:${z}`;
        const cell = this.cells.get(key) ?? [];
        cell.push(collider);
        this.cells.set(key, cell);
      }
    }
    return collider;
  }

  addMesh(mesh: THREE.Mesh, owner: string) {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return this.add(mesh.matrixWorld, mesh.geometry.boundingBox!, owner, mesh.name || 'component');
  }

  private nearby(x: number, z: number, radius: number) {
    this.candidates.clear();
    for (let cy = Math.floor((z - radius) / CELL); cy <= Math.floor((z + radius) / CELL); cy++) {
      for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
        for (const c of this.cells.get(`${cx}:${cy}`) ?? []) this.candidates.add(c);
      }
    }
    return this.candidates;
  }

  overlapsCircle(x: number, z: number, radius: number) {
    for (const c of this.nearby(x, z, radius)) if (c.overlapsCircle(x, z, radius)) return true;
    return false;
  }

  collide(pos: THREE.Vector3, radius: number, height = 1.8) {
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.nearby(pos.x, pos.z, radius)) c.resolveCircle(pos, radius, height);
    }
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number, ignoreOwner?: string): PropRayHit | null {
    this.candidates.clear();
    let cx = Math.floor(origin.x / CELL), cz = Math.floor(origin.z / CELL);
    const sx = dir.x >= 0 ? 1 : -1, sz = dir.z >= 0 ? 1 : -1;
    const dx = Math.abs(dir.x) < EPS ? Infinity : CELL / Math.abs(dir.x);
    const dz = Math.abs(dir.z) < EPS ? Infinity : CELL / Math.abs(dir.z);
    let tx = dx === Infinity ? Infinity : ((dir.x >= 0 ? (cx + 1) * CELL : cx * CELL) - origin.x) / dir.x;
    let tz = dz === Infinity ? Infinity : ((dir.z >= 0 ? (cz + 1) * CELL : cz * CELL) - origin.z) / dir.z;
    let best: PropRayHit | null = null;
    let distance = maxDistance;
    const visits = Math.ceil(maxDistance * (Math.abs(dir.x) + Math.abs(dir.z)) / CELL) + 4;
    for (let step = 0; step < visits; step++) {
      for (const c of this.cells.get(`${cx}:${cz}`) ?? []) {
        if (this.candidates.has(c) || c.owner === ignoreOwner) continue;
        this.candidates.add(c);
        const hit = c.rayHit(origin, dir, distance);
        if (hit && hit.dist <= distance) { distance = hit.dist; best = hit; }
      }
      if (Math.min(tx, tz) > distance || Math.min(tx, tz) === Infinity) break;
      if (tx < tz) { cx += sx; tx += dx; } else { cz += sz; tz += dz; }
    }
    return best;
  }

  /** Capsule clearance for navigation, independent of eye-height line of sight. */
  segmentClear(a: THREE.Vector3, b: THREE.Vector3, radius = 0.55) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.overlapsCircle(THREE.MathUtils.lerp(a.x, b.x, t), THREE.MathUtils.lerp(a.z, b.z, t), radius)) return false;
    }
    return true;
  }
}