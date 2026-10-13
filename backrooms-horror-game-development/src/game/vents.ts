import * as THREE from 'three';
import { tileToWorld, lerp } from './types';
import { ventMetalTexture } from './textures';

/**
 * Ventilation networks — real traversable ductwork hung beneath the ceiling.
 *
 * Every network is a graph of axis-aligned segments between junction nodes.
 * The player crawls along segments (never teleports); creatures path along
 * the same graph. Geometry is built so the interior reads as one continuous
 * tube: segments are open-ended sleeves, junction cubes are capped only on
 * the sides that have no connecting duct, and grate junctions have a hole in
 * the floor where the hinged cover sits.
 */

export const VENT_FLOOR_Y = 2.32; // duct floor height above the room floor
export const VENT_H = 0.82; // interior height
export const VENT_W = 1.05; // interior width
export const VENT_EYE = 0.5; // crawling eye height above the duct floor
const HALF = VENT_W / 2;

export interface VentNodeDef {
  tx: number; ty: number;
  /** Recessed hiding nook: creatures detect a still player far less here. */
  alcove?: boolean;
}

export class VentPortal {
  id = 0;
  network: VentNetwork;
  nodeId: number;
  /** Room position directly beneath the grate. */
  roomPos: THREE.Vector3;
  grateOpen = false;
  /** Seconds left while a Crawler forces this grate. */
  bashTime = 0;
  group = new THREE.Group();
  private pivot = new THREE.Group();
  private angle = 0;

  constructor(network: VentNetwork, nodeId: number) {
    this.network = network;
    this.nodeId = nodeId;
    const n = network.nodes[nodeId].pos;
    this.roomPos = new THREE.Vector3(n.x, 0, n.z);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3d4042, roughness: 0.55, metalness: 0.6 });
    const grateMat = new THREE.MeshStandardMaterial({ map: ventMetalTexture(), roughness: 0.5, metalness: 0.65, side: THREE.DoubleSide });
    // hinge along the -Z edge of the floor hole
    this.pivot.position.set(n.x, VENT_FLOOR_Y - 0.02, n.z - HALF);
    const panel = new THREE.Group();
    panel.position.z = HALF;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(VENT_W - 0.04, 0.035, VENT_W - 0.04), grateMat);
    panel.add(slab);
    for (let i = 0; i < 5; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(VENT_W - 0.14, 0.02, 0.07), frameMat);
      slat.position.set(0, -0.03, -0.38 + i * 0.19);
      slat.rotation.x = 0.55;
      panel.add(slat);
    }
    this.pivot.add(panel);
    // a dark rim around the hole so it reads from below
    const rim = new THREE.Mesh(new THREE.BoxGeometry(VENT_W + 0.12, 0.06, VENT_W + 0.12), frameMat);
    rim.position.set(n.x, VENT_FLOOR_Y - 0.06, n.z);
    const rimHole = new THREE.Mesh(new THREE.BoxGeometry(VENT_W, 0.08, VENT_W), new THREE.MeshBasicMaterial({ color: 0x050505 }));
    rimHole.position.copy(rim.position);
    rimHole.visible = false;
    this.group.add(this.pivot);
  }

  update(dt: number) {
    const target = this.grateOpen ? 1.75 : 0; // swings down into the room
    this.angle = lerp(this.angle, target, 1 - Math.pow(0.0005, dt));
    this.pivot.rotation.x = this.angle;
  }
}

interface VentNode { pos: THREE.Vector3; alcove: boolean; tx: number; ty: number }

export class VentNetwork {
  id: number;
  name: string;
  nodes: VentNode[];
  adjacency: number[][];
  segments: [number, number][] = [];
  portals: VentPortal[] = [];
  group = new THREE.Group();

  constructor(id: number, name: string, defs: VentNodeDef[], edges: [number, number][], portalNodes: number[]) {
    this.id = id;
    this.name = name;
    this.nodes = defs.map((d) => ({
      pos: new THREE.Vector3(tileToWorld(d.tx), VENT_FLOOR_Y, tileToWorld(d.ty)),
      alcove: !!d.alcove, tx: d.tx, ty: d.ty,
    }));
    this.adjacency = defs.map(() => []);
    for (const [a, b] of edges) {
      const na = defs[a], nb = defs[b];
      if (na.tx !== nb.tx && na.ty !== nb.ty) {
        console.warn(`[VENTS] ${name}: segment ${a}-${b} is not axis-aligned and was skipped`);
        continue;
      }
      this.segments.push([a, b]);
      this.adjacency[a].push(b);
      this.adjacency[b].push(a);
    }
    for (const n of portalNodes) this.portals.push(new VentPortal(this, n));
    this.buildGeometry(new Set(portalNodes));
    for (const p of this.portals) this.group.add(p.group);
  }

  /** Grid tiles the ductwork occupies (walls there get a duct-sized cut). */
  tiles(gw: number): number[] {
    const out: number[] = [];
    for (const [a, b] of this.segments) {
      const na = this.nodes[a], nb = this.nodes[b];
      const x0 = Math.min(na.tx, nb.tx), x1 = Math.max(na.tx, nb.tx);
      const y0 = Math.min(na.ty, nb.ty), y1 = Math.max(na.ty, nb.ty);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * gw + x);
    }
    return out;
  }

  private buildGeometry(portalNodes: Set<number>) {
    const tex = ventMetalTexture();
    const inner = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.6, side: THREE.BackSide });
    const outer = new THREE.MeshStandardMaterial({ color: 0x3a3d3f, roughness: 0.7, metalness: 0.5 });
    const none = new THREE.MeshBasicMaterial({ visible: false });
    const cy = VENT_FLOOR_Y + VENT_H / 2;
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
    for (const [a, b] of this.segments) {
      const pa = this.nodes[a].pos, pb = this.nodes[b].pos;
      const alongX = Math.abs(pb.x - pa.x) > 0.01;
      const len = (alongX ? Math.abs(pb.x - pa.x) : Math.abs(pb.z - pa.z)) - VENT_W;
      if (len <= 0.01) continue;
      const mid = new THREE.Vector3((pa.x + pb.x) / 2, cy, (pa.z + pb.z) / 2);
      const capsOpen = alongX ? [none, none, inner, inner, inner, inner] : [inner, inner, inner, inner, none, none];
      const capsOpenOut = alongX ? [none, none, outer, outer, outer, outer] : [outer, outer, outer, outer, none, none];
      const gi = alongX ? new THREE.BoxGeometry(len, VENT_H, VENT_W) : new THREE.BoxGeometry(VENT_W, VENT_H, len);
      const go = alongX ? new THREE.BoxGeometry(len, VENT_H + 0.08, VENT_W + 0.08) : new THREE.BoxGeometry(VENT_W + 0.08, VENT_H + 0.08, len);
      const mi = new THREE.Mesh(gi, capsOpen);
      mi.position.copy(mid);
      const mo = new THREE.Mesh(go, capsOpenOut);
      mo.position.copy(mid);
      this.group.add(mi, mo);
      // seam ribs every couple of metres so distance reads while crawling
      const ribs = Math.floor(len / 1.6);
      for (let i = 1; i <= ribs; i++) {
        const t = i / (ribs + 1) - 0.5;
        const rib = new THREE.Mesh(
          alongX ? new THREE.BoxGeometry(0.05, VENT_H + 0.12, VENT_W + 0.12) : new THREE.BoxGeometry(VENT_W + 0.12, VENT_H + 0.12, 0.05),
          outer,
        );
        rib.position.copy(mid);
        if (alongX) rib.position.x += t * len; else rib.position.z += t * len;
        this.group.add(rib);
      }
    }
    // junction cubes
    this.nodes.forEach((n, i) => {
      const dirs = { px: false, nx: false, pz: false, nz: false };
      for (const j of this.adjacency[i]) {
        const o = this.nodes[j].pos;
        if (o.x > n.pos.x + 0.01) dirs.px = true;
        else if (o.x < n.pos.x - 0.01) dirs.nx = true;
        else if (o.z > n.pos.z + 0.01) dirs.pz = true;
        else if (o.z < n.pos.z - 0.01) dirs.nz = true;
      }
      const hole = portalNodes.has(i);
      const mi = new THREE.Mesh(new THREE.BoxGeometry(VENT_W, VENT_H, VENT_W), [
        dirs.px ? none : inner, dirs.nx ? none : inner, inner, hole ? none : inner,
        dirs.pz ? none : inner, dirs.nz ? none : inner,
      ]);
      mi.position.set(n.pos.x, cy, n.pos.z);
      const mo = new THREE.Mesh(new THREE.BoxGeometry(VENT_W + 0.08, VENT_H + 0.08, VENT_W + 0.08), [
        dirs.px ? none : outer, dirs.nx ? none : outer, outer, hole ? none : outer,
        dirs.pz ? none : outer, dirs.nz ? none : outer,
      ]);
      mo.position.copy(mi.position);
      this.group.add(mi, mo);
      // dim amber inspection lamp on every other junction
      if (i % 2 === 0) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.08), new THREE.MeshBasicMaterial({ color: 0xff9a3c }));
        lamp.position.set(n.pos.x, VENT_FLOOR_Y + VENT_H - 0.02, n.pos.z);
        this.group.add(lamp);
      }
      // alcoves get a scuffed blanket and old claw marks — someone hid here once
      if (n.alcove) {
        const rag = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.45), new THREE.MeshStandardMaterial({ color: 0x3a2e22, roughness: 1 }));
        rag.position.set(n.pos.x + 0.15, VENT_FLOOR_Y + 0.015, n.pos.z);
        rag.rotation.y = 0.4;
        this.group.add(rag);
      }
    });
  }

  /** Dijkstra over the junction graph; returns node ids from → to inclusive. */
  findPath(from: number, to: number): number[] {
    if (from === to) return [from];
    const n = this.nodes.length;
    const dist = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u === -1 || u === to) break;
      done[u] = 1;
      for (const v of this.adjacency[u]) {
        const w = this.nodes[u].pos.distanceTo(this.nodes[v].pos);
        if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
      }
    }
    if (!isFinite(dist[to])) return [];
    const path: number[] = [];
    for (let cur = to; cur !== -1; cur = prev[cur]) {
      path.push(cur);
      if (cur === from) break;
    }
    return path.reverse();
  }

  graphDistance(from: number, to: number): number {
    const path = this.findPath(from, to);
    if (path.length < 2) return from === to ? 0 : Infinity;
    let d = 0;
    for (let i = 1; i < path.length; i++) d += this.nodes[path[i - 1]].pos.distanceTo(this.nodes[path[i]].pos);
    return d;
  }

  nearestNode(pos: THREE.Vector3): number {
    let best = 0;
    let bd = Infinity;
    this.nodes.forEach((nd, i) => {
      const d = nd.pos.distanceToSquared(pos);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  randomNode(excludeCenter?: THREE.Vector3, minDist = 0): number {
    for (let tries = 0; tries < 12; tries++) {
      const i = Math.floor(Math.random() * this.nodes.length);
      if (excludeCenter && this.nodes[i].pos.distanceTo(excludeCenter) < minDist) continue;
      return i;
    }
    return Math.floor(Math.random() * this.nodes.length);
  }
}

/** The player's exact place inside a network: between nodes a and b. */
export interface VentFoothold {
  network: VentNetwork;
  a: number;
  b: number;
  /** 0 at node a … 1 at node b. */
  t: number;
}

export function footholdPos(f: VentFoothold, out: THREE.Vector3): THREE.Vector3 {
  return out.lerpVectors(f.network.nodes[f.a].pos, f.network.nodes[f.b].pos, f.t);
}

/** Graph distance from a creature's node to wherever the player sits. */
export function footholdNodeDistance(net: VentNetwork, fromNode: number, f: VentFoothold): number {
  const toA = net.graphDistance(fromNode, f.a);
  const toB = net.graphDistance(fromNode, f.b);
  const segLen = net.nodes[f.a].pos.distanceTo(net.nodes[f.b].pos);
  return Math.min(toA + f.t * segLen, toB + (1 - f.t) * segLen);
}

/**
 * Network layouts. Every node sits on a floor or wall tile (never a door or
 * pillar) and every segment is axis-aligned; segments may cross walls — the
 * world cuts a duct-sized notch so the tube visibly passes through.
 */
export class VentSystem {
  networks: VentNetwork[] = [];
  portals: VentPortal[] = [];
  group = new THREE.Group();

  constructor() {
    const defs: { name: string; nodes: VentNodeDef[]; edges: [number, number][]; portals: number[] }[] = [
      {
        // LEVEL 4 — maintenance ducts: the Crawler's home. Spine along row 54.
        name: 'MAINTENANCE DUCTS',
        nodes: [
          { tx: 11, ty: 54 }, { tx: 14, ty: 54 }, { tx: 24, ty: 54 }, { tx: 31, ty: 54 },
          { tx: 14, ty: 48 }, { tx: 24, ty: 58, alcove: true }, { tx: 16, ty: 58 }, { tx: 31, ty: 48 },
        ],
        edges: [[0, 1], [1, 2], [2, 3], [1, 4], [2, 5], [5, 6], [3, 7]],
        portals: [0, 4, 6, 7],
      },
      {
        // LEVEL 5 — the dry bypass over the flood to the pump platform
        name: 'FLOOD BYPASS DUCTS',
        nodes: [
          { tx: 39, ty: 57 }, { tx: 39, ty: 48 }, { tx: 50, ty: 48 }, { tx: 62, ty: 48 }, { tx: 50, ty: 53, alcove: true },
        ],
        edges: [[0, 1], [1, 2], [2, 3], [2, 4]],
        portals: [0, 3],
      },
      {
        // LEVEL 6 — office ceiling roads: the Vent Stalker's parish
        name: 'OFFICE CEILING ROADS',
        nodes: [
          { tx: 12, ty: 72 }, { tx: 22, ty: 72 }, { tx: 22, ty: 76 }, { tx: 29, ty: 76, alcove: true },
          { tx: 22, ty: 82 }, { tx: 34, ty: 82 },
        ],
        edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]],
        portals: [0, 2, 5],
      },
      {
        // LEVEL 8 — the nest warren: a ring around the Guardian's chamber
        name: 'NEST WARREN',
        nodes: [
          { tx: 11, ty: 93 }, { tx: 26, ty: 93 }, { tx: 34, ty: 93 }, { tx: 34, ty: 107 },
          { tx: 11, ty: 107 }, { tx: 11, ty: 100 }, { tx: 26, ty: 99, alcove: true },
        ],
        edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 6]],
        portals: [2, 3, 5],
      },
    ];
    defs.forEach((d, i) => {
      const net = new VentNetwork(i, d.name, d.nodes, d.edges, d.portals);
      for (const p of net.portals) {
        p.id = this.portals.length;
        this.portals.push(p);
      }
      this.networks.push(net);
      this.group.add(net.group);
    });
  }

  update(dt: number) {
    for (const p of this.portals) p.update(dt);
  }

  ductTiles(gw: number): Set<number> {
    const s = new Set<number>();
    for (const n of this.networks) for (const t of n.tiles(gw)) s.add(t);
    return s;
  }

  /** Portal whose grate is above a standing player's reach. */
  portalNear(pos: THREE.Vector3, maxDist = 1.9): VentPortal | null {
    let best: VentPortal | null = null;
    let bd = maxDist;
    for (const p of this.portals) {
      const d = Math.hypot(p.roomPos.x - pos.x, p.roomPos.z - pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Portal at a given network node (for climbing out). */
  portalAt(net: VentNetwork, node: number): VentPortal | null {
    return net.portals.find((p) => p.nodeId === node) ?? null;
  }
}
