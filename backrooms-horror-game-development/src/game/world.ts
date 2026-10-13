import * as THREE from 'three';
import {
  TILE, WALL_H, tileToWorld, worldToTile, clamp, lerp,
  Interactable, EnemyKind, AmmoKind,
} from './types';
import * as TX from './textures';
import { FurnitureBuilder, FURNITURE_PARTS, furnitureTransform, type FurnitureKind } from './furniture';
import { PropCollisionIndex } from './propCollision';
import { runPropRegressionChecks } from './props.regression';

// ------------------------------------------------------------------ utils
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GW = 70;
export const GH = 118;
const T_WALL = 0;
const T_FLOOR = 1;
const T_PILLAR = 2;

// ------------------------------------------------------------------ types
export interface AreaDef {
  id: number;
  name: string;
  sub: string;
  x0: number; y0: number; x1: number; y1: number;
  wall: 'yellow' | 'service' | 'facility';
  floor: 'carpet' | 'concrete' | 'dark';
  fog: number;
  fogColor: number;
  lightEvery: number; // fixture spacing in tiles
  darkFrac: number; // fraction of fixtures dead
  tint: 'warm' | 'cool' | 'red'; // fixture colour cast
}

export type DoorKind = 'normal' | 'keycard' | 'power' | 'exit' | 'gold' | 'p2' | 'p3' | 'pumps' | 'fuse' | 'exit2' | 'lab';
export type DoorAccess =
  | 'open' | 'need-keycard' | 'need-power' | 'need-both'
  | 'need-gold' | 'need-p2' | 'need-p3' | 'need-pumps' | 'need-fuse' | 'need-lab';

export class Door {
  tx: number; ty: number;
  kind: DoorKind;
  pos: THREE.Vector3;
  group = new THREE.Group();
  slab!: THREE.Mesh;
  slab2: THREE.Mesh | null = null;
  keypadLight!: THREE.Mesh;
  openness = 0; // 0 closed .. 1 open
  target = 0;
  moving = false;
  baseX = 0;
  get id() { return this.tx * 1000 + this.ty; }
  constructor(tx: number, ty: number, kind: DoorKind) {
    this.tx = tx; this.ty = ty; this.kind = kind;
    this.pos = new THREE.Vector3(tileToWorld(tx), 0, tileToWorld(ty));
  }
  get closed() { return this.openness < 0.7; }
  get fullyClosed() { return this.openness < 0.02; }
}

export type PickupKind =
  | AmmoKind
  | 'medkit' | 'keycard' | 'goldkey' | 'fuse'
  | 'weapon-shotgun' | 'weapon-smg' | 'weapon-rifle' | 'weapon-magnum'
  | 'weapon-ak' | 'weapon-m16' | 'weapon-sniper'
  | 'weapon-bazooka' | 'weapon-rocket' | 'weapon-antimatter';

export interface PickupDef {
  id: number;
  kind: PickupKind;
  pos: THREE.Vector3;
  mesh: THREE.Group;
  taken: boolean;
}

export interface NoteDef { id: number; pos: THREE.Vector3; title: string; body: string; mesh: THREE.Object3D }
export interface CrateDef { id: number; pos: THREE.Vector3; looted: boolean; mesh: THREE.Object3D }
export interface EnemySpawn {
  kind: EnemyKind;
  pos: THREE.Vector3;
  patrol: THREE.Vector3[];
  scripted?: boolean;
}

export interface WorldHooks {
  doorAccess(d: Door): DoorAccess;
  onDoorOpened(d: Door): void;
  pickupTaken(p: PickupDef): boolean;
  noteRead(n: NoteDef): void;
  /** which: 1 = G-2 (service maze), 2 = G-3 (maintenance), 3 = G-4 (blackout). */
  generatorActivated(which: number): void;
  pumpActivated(): void;
  /** Containment console in L9: unseals chamber 9-C. */
  labActivated(): void;
  /** Both the threshold door (kind 'exit') and the final door ('exit2'). */
  exitOpened(d: Door): void;
  crateLoot(c: CrateDef): void;
  doorSound(d: Door, opening: boolean, denied: boolean): void;
}

/** Human-readable lock reasons for door prompts. */
export const ACCESS_LABEL: Record<Exclude<DoorAccess, 'open'>, string> = {
  'need-keycard': 'LOCKED — KEYCARD REQUIRED',
  'need-power': 'LOCKED — NO POWER',
  'need-both': 'SEALED — NEEDS KEYCARD + POWER',
  'need-gold': 'LOCKED — GOLD KEYCARD REQUIRED',
  'need-p2': 'LOCKED — GENERATOR G-3 OFFLINE',
  'need-p3': 'LOCKED — GENERATOR G-4 OFFLINE',
  'need-pumps': 'LOCKED — DRAINAGE PUMPS OFFLINE',
  'need-fuse': 'LOCKED — CORE FUSE MISSING',
  'need-lab': 'SEALED — CONTAINMENT ACTIVE (USE THE LAB CONSOLE)',
};

interface Fixture { pos: THREE.Vector3; seed: number; dead: boolean; deadOrig: boolean; area: number; level: number }

/** Area index of the Blackout Zone (G-4 revives its lights). */
export const BLACKOUT_AREA = 8;
interface Obstacle { minX: number; maxX: number; minZ: number; maxZ: number }

/** Exact 3D solid box used by the raycaster (pillars, door frames, slabs). */
interface RayBox { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

// =================================================================== WORLD
export class World {
  group = new THREE.Group();
  grid = new Uint8Array(GW * GH);
  doors: Door[] = [];
  private doorMap = new Map<number, Door>();
  interactables: Interactable[] = [];
  pickups: PickupDef[] = [];
  notes: NoteDef[] = [];
  crates: CrateDef[] = [];
  enemySpawns: EnemySpawn[] = [];
  areas: AreaDef[] = [];
  obstacles: Obstacle[] = [];
  /** Exact solid boxes for the raycaster: pillars, door posts, door lintels. */
  private rayBoxes: RayBox[] = [];
  /** Live door-slab hitboxes, recomputed as the slabs slide. */
  private doorSlabs: { foot: Obstacle; box: RayBox; mesh: THREE.Mesh; door: Door }[] = [];
  private propCollisions = new PropCollisionIndex();
  private controlOwners = new Map<string, string>();
  fixtures: Fixture[] = [];
  generatorPos = new THREE.Vector3();
  gen2Pos = new THREE.Vector3();
  gen3Pos = new THREE.Vector3();
  pumpPos = new THREE.Vector3();
  /** Sparking electrical cabinet in the flooded complex (Game runs the arcs). */
  hazardPos = new THREE.Vector3();
  power2On = false;
  power3On = false;
  pumpsDrained = false;
  /** Flooded-complex water: tile index sets + the deep-water surface mesh. */
  waterTiles = new Set<number>();
  deepWaterTiles = new Set<number>();
  private deepWaterMesh: THREE.InstancedMesh | null = null;
  exitDoor!: Door;
  playerSpawn = new THREE.Vector3(10, 1.7, 50);
  playerSpawnYaw = Math.PI / 2;
  private hooks: WorldHooks;
  private rng = mulberry32(1337);

  private lights: THREE.PointLight[] = [];
  private lightBudget = 6;
  private fixtureMesh!: THREE.InstancedMesh;
  private fixturePanelMat!: THREE.MeshBasicMaterial;
  private fixtureTime = 0;
  flickerEvent = 0; // seconds remaining of global flicker
  powerOn = false;
  private pickupTime = 0;
  private doorInteractCooldown = new Map<number, number>();

  /** Wall tiles that ductwork passes through (rendered with a notch). */
  private ductTiles: Set<number>;
  /** Containment 9-C: console unlocks the chamber holding the anti-matter gun. */
  labConsolePos = new THREE.Vector3();
  labChamberPos = new THREE.Vector3();
  labUnlocked = false;
  private labLight: THREE.PointLight | null = null;
  private labLevel = 0;

  constructor(hooks: WorldHooks, ductTiles: Set<number> = new Set()) {
    if (import.meta.env.DEV) runPropRegressionChecks();
    this.hooks = hooks;
    this.ductTiles = ductTiles;
    this.buildLayout();
    this.validateConnectivity();
    this.buildGeometry();
    this.buildLights();
    this.buildInteractables();
  }

  /**
   * Regression guard: flood-fill from the player spawn over floor tiles
   * (door tiles count as floor — they can always be opened eventually)
   * and verify every floor tile and every critical objective tile is
   * reachable. A single uncarved tile once sealed the Dark Zone entrance;
   * this makes that class of bug fail loudly in the console instead of
   * silently trapping the player.
   */
  private validateConnectivity() {
    const startX = worldToTile(this.playerSpawn.x);
    const startY = worldToTile(this.playerSpawn.z);
    const seen = new Uint8Array(GW * GH);
    const queue: number[] = [this.idx(startX, startY)];
    seen[queue[0]] = 1;
    while (queue.length) {
      const cur = queue.pop()!;
      const cx = cur % GW;
      const cy = Math.floor(cur / GW);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nk = this.idx(nx, ny);
        if (seen[nk]) continue;
        if (this.tileAt(nx, ny) !== T_FLOOR) continue;
        seen[nk] = 1;
        queue.push(nk);
      }
    }
    const unreachable: string[] = [];
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (this.tileAt(x, y) === T_FLOOR && !seen[this.idx(x, y)]) unreachable.push(`(${x},${y})`);
      }
    }
    const critical: Record<string, [number, number]> = {
      'service maze entry': [24, 8],
      'keycard room': [26, 15],
      'generator G-2': [43, 2],
      'facility entry (keycard door)': [30, 21],
      'dark zone gate corridor': [37, 30],
      'dark zone entry': [38, 30],
      'threshold entry': [57, 30],
      'threshold door': [65, 30],
      'descent shaft': [67, 40],
      'maintenance maze (L4)': [20, 54],
      'generator G-3': [32, 47],
      'flooded complex (L5)': [50, 54],
      'drainage pumps': [62, 47],
      'abandoned office (L6)': [22, 77],
      'gold keycard (security office)': [11, 70],
      'blackout zone (L7)': [50, 77],
      'generator G-4': [64, 83],
      'the nest (L8)': [22, 99],
      'core fuse': [10, 99],
      'exit experiment (L9)': [50, 99],
      'final exit': [66, 99],
      'final escape corridor': [68, 99],
      'fuse gate (row 104)': [38, 104],
      'containment chamber 9-C (anti-matter)': [62, 93],
      'emergency armory (bazooka)': [61, 85],
      'weapons-test locker (rocket launcher)': [9, 105],
    };
    const blockedCritical = Object.entries(critical)
      .filter(([, [x, y]]) => !seen[this.idx(x, y)])
      .map(([name]) => name);
    if (unreachable.length || blockedCritical.length) {
      console.warn(
        `[WORLD] Connectivity check FAILED — unreachable floor tiles: ${unreachable.length}` +
        (blockedCritical.length ? ` · blocked critical locations: ${blockedCritical.join(', ')}` : '') +
        (unreachable.length ? ` · first tiles: ${unreachable.slice(0, 12).join(' ')}` : ''),
      );
    }
  }

  // ---------------------------------------------------------- layout gen
  private idx(x: number, y: number) { return y * GW + x; }
  private set(x: number, y: number, v: number) {
    if (x >= 0 && y >= 0 && x < GW && y < GH) this.grid[this.idx(x, y)] = v;
  }
  tileAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= GW || y >= GH) return T_WALL;
    return this.grid[this.idx(x, y)];
  }
  private carve(x0: number, y0: number, x1: number, y1: number) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, T_FLOOR);
  }
  private wallRect(x0: number, y0: number, x1: number, y1: number) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, T_WALL);
  }
  private pillar(x: number, y: number) { this.set(x, y, T_PILLAR); }

  /** Flood a rectangle of floor; the inner rectangle is deep water. */
  private markWater(x0: number, y0: number, x1: number, y1: number, dx0: number, dy0: number, dx1: number, dy1: number) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.tileAt(x, y) !== T_FLOOR) continue;
        this.waterTiles.add(this.idx(x, y));
        if (x >= dx0 && x <= dx1 && y >= dy0 && y <= dy1) this.deepWaterTiles.add(this.idx(x, y));
      }
    }
  }

  /** 0 = dry, 1 = shallow, 2 = deep (deep reads as shallow once drained). */
  waterAt(pos: THREE.Vector3): number {
    const k = this.idx(worldToTile(pos.x), worldToTile(pos.z));
    if (!this.waterTiles.has(k)) return 0;
    if (this.deepWaterTiles.has(k) && !this.pumpsDrained) return 2;
    return 1;
  }

  private buildWaterMeshes() {
    if (this.waterTiles.size === 0) return;
    const geo = new THREE.PlaneGeometry(TILE * 0.99, TILE * 0.99);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const m4 = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    const shallowMat = new THREE.MeshStandardMaterial({
      color: 0x2b4c5a, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.42, envMapIntensity: 1.6,
    });
    const shallow = new THREE.InstancedMesh(geo, shallowMat, this.waterTiles.size);
    let i = 0;
    for (const k of this.waterTiles) {
      const x = k % GW;
      const y = Math.floor(k / GW);
      m4.compose(new THREE.Vector3(tileToWorld(x), 0.055, tileToWorld(y)), rot, one);
      shallow.setMatrixAt(i++, m4);
    }
    shallow.instanceMatrix.needsUpdate = true;
    this.group.add(shallow);
    const deepMat = new THREE.MeshStandardMaterial({
      color: 0x12242e, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.66, envMapIntensity: 1.8,
    });
    const deep = new THREE.InstancedMesh(geo, deepMat, this.deepWaterTiles.size);
    i = 0;
    for (const k of this.deepWaterTiles) {
      const x = k % GW;
      const y = Math.floor(k / GW);
      m4.compose(new THREE.Vector3(tileToWorld(x), 0.17, tileToWorld(y)), rot, one);
      deep.setMatrixAt(i++, m4);
    }
    deep.instanceMatrix.needsUpdate = true;
    this.group.add(deep);
    this.deepWaterMesh = deep;
  }

  /** Drainage pumps on: deep water drops to a sheen. */
  setDrained(on: boolean) {
    this.pumpsDrained = on;
    if (this.deepWaterMesh) this.deepWaterMesh.visible = !on;
  }
  private door(x: number, y: number, kind: DoorKind): Door {
    this.set(x, y, T_FLOOR);
    const d = new Door(x, y, kind);
    this.doors.push(d);
    this.doorMap.set(this.idx(x, y), d);
    if (kind === 'exit') this.exitDoor = d;
    return d;
  }

  private buildLayout() {
    this.grid.fill(T_WALL);
    const A = (
      name: string, sub: string, x0: number, y0: number, x1: number, y1: number,
      wall: AreaDef['wall'], floor: AreaDef['floor'], fog: number, fogColor: number,
      lightEvery: number, darkFrac: number, tint: AreaDef['tint'] = 'warm',
    ): AreaDef => {
      const a: AreaDef = { id: this.areas.length, name, sub, x0, y0, x1, y1, wall, floor, fog, fogColor, lightEvery, darkFrac, tint };
      this.areas.push(a);
      this.carve(x0, y0, x1, y1);
      return a;
    };

    // ---- AREA 1 · THE YELLOW HALLS
    A('LEVEL 0 — THE YELLOW HALLS', 'the lobby · it hums, it waits', 1, 1, 19, 15, 'yellow', 'carpet', 0.030, 0x0a0803, 3, 0.06);
    this.wallRect(10, 8, 13, 8); this.wallRect(15, 8, 18, 8);
    this.door(14, 8, 'normal');
    this.wallRect(10, 9, 10, 11);
    this.pillar(4, 3); this.pillar(8, 5); this.pillar(16, 4); this.pillar(5, 13); this.pillar(17, 12);
    this.playerSpawn.set(tileToWorld(3), 1.7, tileToWorld(12));
    this.playerSpawnYaw = -Math.PI / 2; // face east (+X)

    // corridor 1→2
    this.carve(19, 8, 24, 9);

    // ---- AREA 2 · THE SERVICE MAZE
    A('LEVEL 1 — THE SERVICE MAZE', 'maintenance · mind the gaps in the hum', 24, 1, 45, 17, 'service', 'concrete', 0.036, 0x060705, 3, 0.15);
    this.wallRect(24, 6, 29, 6); this.wallRect(31, 6, 35, 6);
    this.wallRect(36, 6, 36, 8); this.wallRect(36, 10, 36, 12);
    this.wallRect(30, 12, 32, 12); this.wallRect(34, 12, 40, 12); this.wallRect(42, 12, 44, 12);
    // keycard room (SW)
    this.wallRect(24, 12, 28, 12);
    this.wallRect(29, 13, 29, 13); this.wallRect(29, 15, 29, 16);
    this.door(29, 14, 'normal');
    // generator room (NE)
    this.wallRect(38, 5, 40, 5); this.wallRect(42, 5, 45, 5);
    this.door(41, 5, 'normal');
    this.pillar(26, 9); this.pillar(33, 3); this.pillar(43, 9); this.pillar(27, 15);

    // corridor 2→3 (keycard locked) — single tile wide so the door truly gates it
    this.carve(30, 18, 30, 20);
    this.door(30, 19, 'keycard');

    // ---- AREA 3 · THE ABANDONED FACILITY
    A('LEVEL 2 — THE ABANDONED FACILITY', 'they worked here · they left in a hurry', 1, 21, 33, 38, 'facility', 'dark', 0.042, 0x070604, 3, 0.22);
    this.wallRect(12, 22, 12, 26); this.wallRect(12, 28, 12, 30);
    this.door(12, 27, 'normal');
    this.wallRect(2, 31, 9, 31); this.wallRect(13, 31, 15, 31); this.wallRect(17, 31, 21, 31);
    this.door(16, 31, 'normal');
    this.wallRect(22, 33, 22, 37);
    this.pillar(18, 24); this.pillar(26, 24); this.pillar(18, 35); this.pillar(28, 30); this.pillar(6, 25);

    // gate corridor 3→4 (needs power) — single tile wide.
    // Must carve all the way to x=37: the Dark Zone rect starts at x=38,
    // so stopping at 36 leaves tile (37,30) as solid wall sealing the level.
    this.carve(34, 30, 37, 30);
    this.door(35, 30, 'power');

    // ---- AREA 4 · THE DARK ZONE
    A('LEVEL 3 — THE DARK ZONE', 'the lights gave up here · so should you', 38, 21, 53, 38, 'yellow', 'dark', 0.062, 0x030302, 5, 0.55, 'cool');
    this.wallRect(40, 28, 43, 28);
    this.wallRect(47, 34, 50, 34);
    this.wallRect(50, 23, 50, 24);
    // rifle nook (NE)
    this.wallRect(49, 25, 50, 25); this.wallRect(52, 25, 53, 25);
    this.door(51, 25, 'normal');
    this.pillar(42, 24); this.pillar(46, 31); this.pillar(41, 35); this.pillar(52, 30);

    // corridor 4→5
    this.carve(54, 29, 56, 31);

    // ---- AREA 5 · THE THRESHOLD (was the finale; the "exit" only goes down)
    A('THE THRESHOLD', 'the exit was a lie · it only goes down from here', 57, 24, 65, 36, 'facility', 'concrete', 0.045, 0x050403, 3, 0.2);
    this.wallRect(61, 24, 61, 27); this.wallRect(61, 29, 61, 33);
    this.door(61, 28, 'normal');
    // the threshold door sits in a real wall: previously the tiles above and
    // below it were floor, so the player could step around the sealed door
    this.wallRect(65, 24, 65, 29); this.wallRect(65, 31, 65, 36);
    this.door(65, 30, 'exit');
    // descent shaft: one tile wide so it can only be entered through the door,
    // and carried all the way to row 54 so it actually meets the L4 door
    this.carve(66, 30, 67, 30);
    this.carve(67, 30, 67, 44);
    this.carve(36, 44, 67, 44);
    this.carve(36, 44, 36, 54);
    this.pillar(59, 26); this.pillar(63, 34);

    // ---- LEVEL 4 · THE MAINTENANCE MAZE (vents are introduced here)
    A('LEVEL 4 — THE MAINTENANCE MAZE', 'it breathes through these walls', 8, 46, 34, 62, 'service', 'concrete', 0.040, 0x060604, 3, 0.18);
    this.door(35, 54, 'normal');
    this.wallRect(10, 52, 16, 52); this.wallRect(18, 52, 24, 52);
    this.door(17, 52, 'normal');
    this.wallRect(20, 56, 20, 59); this.wallRect(20, 61, 20, 62);
    this.wallRect(28, 50, 31, 50); this.wallRect(33, 50, 34, 50);
    this.door(32, 50, 'normal');
    this.pillar(12, 49); this.pillar(24, 60); this.pillar(30, 55);
    // gate to the flooded complex (needs generator G-3)
    this.carve(35, 58, 37, 58);
    this.door(36, 58, 'p2');

    // ---- LEVEL 5 · THE FLOODED COMPLEX
    A('LEVEL 5 — THE FLOODED COMPLEX', 'the water remembers every footstep', 38, 46, 64, 62, 'service', 'dark', 0.044, 0x04070a, 3, 0.25, 'cool');
    this.wallRect(46, 50, 52, 50);
    this.wallRect(56, 56, 62, 56);
    this.pillar(44, 58); this.pillar(58, 49); this.pillar(50, 60);
    // the whole hall is wet; the middle is deep enough to drag at your legs.
    // Columns 38-39 (entry) and 61-64 (pump platform) are only shallow.
    this.markWater(38, 46, 64, 62, 40, 46, 60, 61);
    // flooded wing exit (needs the drainage pumps running). Routed through the
    // gap rows 63-67 so it can't leak sideways into the office around the door.
    this.carve(39, 63, 39, 65);
    this.carve(30, 65, 39, 65);
    this.carve(30, 66, 30, 66);
    this.door(30, 67, 'pumps');

    // ---- LEVEL 6 · THE ABANDONED OFFICE
    A('LEVEL 6 — THE ABANDONED OFFICE', 'every desk is still waiting for its owner', 8, 68, 36, 86, 'facility', 'carpet', 0.036, 0x070605, 3, 0.12);
    // security office (NW) holding the gold keycard
    this.wallRect(9, 74, 10, 74); this.wallRect(12, 74, 14, 74);
    this.wallRect(14, 69, 14, 73);
    this.door(11, 74, 'normal');
    this.wallRect(20, 68, 20, 74); this.wallRect(20, 76, 20, 80);
    this.wallRect(26, 80, 36, 80);
    this.door(30, 80, 'normal');
    this.pillar(17, 71); this.pillar(24, 72); this.pillar(31, 70);
    this.pillar(17, 83); this.pillar(25, 84); this.pillar(33, 84);
    // gate east (needs the gold keycard)
    this.carve(37, 77, 39, 77);
    this.door(38, 77, 'gold');

    // ---- LEVEL 7 · THE BLACKOUT ZONE
    A('LEVEL 7 — THE BLACKOUT ZONE', 'what the dark keeps, it keeps quietly', 40, 68, 66, 86, 'yellow', 'dark', 0.075, 0x020202, 4, 0.88, 'red');
    this.wallRect(48, 74, 54, 74);
    this.wallRect(58, 68, 58, 72); this.wallRect(58, 74, 58, 78);
    this.wallRect(60, 80, 66, 80);
    this.door(62, 80, 'normal');
    this.pillar(45, 71); this.pillar(52, 82); this.pillar(62, 71);
    // passage south-west down to the nest (needs generator G-4)
    this.carve(38, 86, 39, 86);
    this.carve(38, 87, 38, 98);
    this.door(37, 98, 'p3');

    // ---- LEVEL 8 · THE NEST
    A('LEVEL 8 — THE NEST', 'you are inside the animal now', 8, 90, 36, 108, 'service', 'dark', 0.055, 0x0a0303, 4, 0.4, 'red');
    this.wallRect(8, 96, 13, 96);
    this.wallRect(31, 102, 36, 102);
    this.wallRect(20, 90, 20, 94);
    this.pillar(16, 100); this.pillar(28, 98); this.pillar(24, 106); this.pillar(12, 104);
    // gate east (needs the core fuse). Moved to row 104: on row 99 it touched
    // the G-4 corridor and the p3 door tile, muddling which door gated what.
    this.carve(37, 104, 39, 104);
    this.door(38, 104, 'fuse');

    // ---- LEVEL 9 · THE EXIT EXPERIMENT (east edge at x=65 so x=66 is solid
    // wall around the exit door — no stepping around it)
    A('LEVEL 9 — THE EXIT EXPERIMENT', 'they built a door and called it science', 40, 90, 65, 108, 'facility', 'concrete', 0.040, 0x050505, 3, 0.15, 'cool');
    this.wallRect(48, 90, 48, 97); this.wallRect(48, 99, 48, 104);
    this.wallRect(50, 98, 55, 98);
    this.door(56, 98, 'normal');
    this.pillar(45, 104); this.pillar(60, 104); this.pillar(52, 93);
    // containment chamber 9-C (holds the anti-matter gun), sealed until the
    // console in the south-west lab is used
    this.wallRect(58, 90, 58, 95);
    this.wallRect(59, 95, 61, 95); this.wallRect(63, 95, 65, 95);
    this.door(62, 95, 'lab');
    // the real way out
    this.door(66, 99, 'exit2');
    this.carve(67, 98, 69, 100);

    this.generatorPos.set(tileToWorld(43), 0, tileToWorld(2));
    this.gen2Pos.set(tileToWorld(32), 0, tileToWorld(47));
    this.gen3Pos.set(tileToWorld(64), 0, tileToWorld(83));
    this.pumpPos.set(tileToWorld(62), 0, tileToWorld(47));
    this.hazardPos.set(tileToWorld(55), 0, tileToWorld(54));
    this.labConsolePos.set(tileToWorld(44), 0, tileToWorld(106));
    this.labChamberPos.set(tileToWorld(62), 0, tileToWorld(92));
    this.defineSpawns();
  }

  private defineSpawns() {
    const P = (kind: PickupKind, x: number, y: number) =>
      this.pickups.push({ id: this.pickups.length, kind, pos: new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)), mesh: new THREE.Group(), taken: false });
    const N = (x: number, y: number, title: string, body: string) =>
      this.notes.push({ id: this.notes.length, pos: new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)), title, body, mesh: new THREE.Group() });
    const C = (x: number, y: number) =>
      this.crates.push({ id: this.crates.length, pos: new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)), looted: false, mesh: new THREE.Group() });
    const E = (kind: EnemyKind, x: number, y: number, patrol: [number, number][], scripted = false) =>
      this.enemySpawns.push({
        kind,
        pos: new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)),
        patrol: patrol.map(([px, py]) => new THREE.Vector3(tileToWorld(px), 0, tileToWorld(py))),
        scripted,
      });

    // ---- Area 1 · the player wakes holding the P229 (slot 1) — spare mags near the spawn
    P('ammo-pistol', 5, 7); P('ammo-pistol', 16, 3); P('medkit', 5, 14); P('ammo-pistol', 18, 14);
    N(3, 11, 'NOTE — "ORIENTATION"', 'Welcome to your shift. The building has 0 exits and 1 rule: if the humming stops, stop moving. If you hear footsteps that are not yours, do not turn around quickly. — M.');
    N(17, 2, 'NOTE — TORN PAGE', '...it stood at the end of the hall again. Too tall. When the lights blinked it was closer. I counted the blinks. It moves between them...');

    // ---- Area 2 · LEVEL 1 ENTRANCE CACHE → SMG (tile 27,8 sits in the entry path)
    P('weapon-smg', 27, 8); P('ammo-smg', 28, 9);
    P('keycard', 26, 15); P('shells', 44, 16); P('ammo-pistol', 25, 2); P('medkit', 33, 14); P('ammo-smg', 44, 8);
    N(43, 3, 'NOTE — MAINTENANCE LOG', 'Generator G-2 feeds the east gate and the emergency exit. She drinks fuel but she still runs. Keycard opens the south shaft. Whatever scratches in the vents — it is not rats. Rats don\'t knock twice.');
    N(25, 15, 'NOTE — BLOODIED SCRAP', 'It took D. through the vent. I can still hear him counting ceiling tiles somewhere above me. If you find this: the card is here. The door is south. God forgive the architects.');
    C(25, 16); C(44, 2); C(31, 8); C(38, 16);

    // ---- Area 3 · LEVEL 2 ENTRANCE CACHE → SHOTGUN (directly past the keycard door)
    P('weapon-shotgun', 30, 23); P('shells', 29, 23);
    // AK-47 cached in the west storage rooms, off the beaten path
    P('weapon-ak', 3, 29); P('ammo-ak', 4, 28); P('ammo-ak', 33, 34);
    P('shells', 3, 36); P('ammo-smg', 3, 23); P('shells', 4, 34); P('shells', 30, 37);
    P('ammo-smg', 8, 29); P('ammo-rifle', 24, 23); P('medkit', 30, 22); P('medkit', 6, 33); P('ammo-pistol', 20, 29);
    N(31, 22, 'NOTE — SECURITY MEMO', 'Incident 114: the big one does not chase. It walks. Walls are suggestions. Doors are delays. If it raises its arms, be somewhere else. Shotguns recommended. Prayers optional.');
    N(4, 37, 'NOTE — ARMOURY TAG', 'Pump-action, property of Facilities Security. Last user scratched one word into the stock: LISTEN.');
    N(19, 33, 'NOTE — WHITEBOARD SCRIBBLE', 'It watches from the dark between lights. Don\'t stare back. Don\'t shoot the watcher. (underneath, shakier:) I stared. I\'m sorry. I\'m so sorry.');
    C(32, 37); C(2, 22); C(18, 29); C(27, 36);

    // ---- Area 4 · LEVEL 3 ENTRANCE CACHE → RIFLE (first tile inside the dark zone)
    P('weapon-rifle', 39, 30); P('ammo-rifle', 40, 30);
    // L96 sniper cached in the locked NE nook — a dangerous detour in the dark
    P('weapon-sniper', 52, 22); P('ammo-sniper', 51, 22); P('ammo-sniper', 43, 35);
    P('ammo-rifle', 51, 23); P('ammo-rifle', 41, 22);
    P('medkit', 39, 37); P('shells', 45, 37); P('ammo-smg', 39, 24);
    N(40, 22, 'NOTE — LAST TRANSMISSION', 'No lights past this point worth trusting. It likes the dark because in the dark you do the scaring for it. Keep moving. The exit hums green. Follow the green.');
    C(48, 22); C(40, 33);

    // ---- LEVEL 4 · MAINTENANCE MAZE
    P('medkit', 10, 48); P('ammo-ak', 20, 48); P('shells', 33, 61); P('ammo-smg', 26, 54); P('ammo-rifle', 12, 54);
    N(13, 55, 'NOTE — DUCTWORK MEMO', 'The ducts up there connect everything. Pop a grate with E, then CROUCH to climb in. You can shoot in there, but everything in the dark can hear a gun. If metal starts screaming, it is not the pipes. Run for a grate and get out. — R.');
    N(31, 60, 'NOTE — GRAVEYARD SHIFT', 'G-3 feeds the flood gate east. The thing in the ducts knocked three times last night. I knocked back twice. It has not knocked since. I think it is learning manners. I think it is learning ME.');
    C(12, 61); C(31, 52);

    // ---- LEVEL 5 · FLOODED COMPLEX
    P('medkit', 39, 47); P('ammo-rifle', 61, 47); P('shells', 45, 60); P('medkit', 50, 47); P('ammo-sniper', 63, 60);
    N(60, 48, 'NOTE — PUMP CONTROLS', 'Drainage pumps on the north-east platform. Start them and the east water drops to your ankles. Mind cabinet E-9 mid-hall: it arcs when it pleases, and wet skin conducts opinions. The ducts overhead will get you to the pumps dry. Mostly. Something nests up there too.');
    C(40, 61); C(63, 47);

    // ---- LEVEL 6 · ABANDONED OFFICE
    P('goldkey', 11, 70); P('medkit', 33, 70); P('ammo-rifle', 25, 75); P('ammo-ak', 16, 78); P('shells', 34, 83);
    N(18, 70, 'NOTE — STAFF NOTICE', 'Reminder: the floor plan changed again overnight. Security holds the gold pass. If a meeting room has one chair too many, leave. Do not count the chairs out loud. It counts with you.');
    N(22, 84, 'NOTE — IT TAPS BACK', 'Above the desks, in the ceiling roads, something patient follows the sound of typing that stopped years ago. When it taps, freeze. It is listening for where your ears point. It hates being watched almost as much as I hate being followed.');
    C(15, 85); C(34, 76);

    // ---- LEVEL 7 · BLACKOUT ZONE
    P('medkit', 42, 84); P('ammo-sniper', 52, 70); P('ammo-ak', 66, 69); P('shells', 41, 69);
    // ENDGAME · M9 BAZOOKA in the emergency armory behind the G-4 door
    // (picked up before the Nest Guardian it's meant to answer)
    P('weapon-bazooka', 61, 85); P('ammo-rocket', 60, 84); P('ammo-rocket', 66, 83);
    N(63, 85, 'NOTE — LAST STAND, ARMORY B', 'We dragged the M9 down here to hold the stairwell. Two rockets left. The big one in the nest below shrugged off rifle fire like rain — the tube made it flinch. Do not fire it in a corridor. I did. That is why I am writing this sitting down.');
    N(41, 69, 'NOTE — BLACKOUT PROTOCOL', 'Mains are dead past this point; the red lamps drink from G-4 in the south-east closet. Start her and the hall remembers it has edges. Your torch is law down here. Nothing hunts what it cannot hear, so walk like the floor owes you money.');
    C(65, 70); C(45, 85);

    // ---- LEVEL 8 · THE NEST
    P('fuse', 10, 99); P('medkit', 34, 92); P('ammo-ak', 30, 92); P('shells', 12, 107); P('ammo-rifle', 33, 105);
    // ENDGAME · HL-4 ROCKET LAUNCHER — the optional prize in the Guardian's
    // territory (SW corner, also reachable through the warren's west grate)
    P('weapon-rocket', 9, 105); P('ammo-missile', 10, 106); P('ammo-rocket', 33, 91);
    N(9, 103, 'NOTE — WEAPONS TEST LOCKER 4', 'HL-4 smart launcher, prototype. Hold your aim on the target until the seeker turns green, then fire — the missile does the rest. It will not lock what it cannot see. Neither will you. Locker relocated to the nest perimeter after the incident; nobody volunteered to fetch it back.');
    N(18, 107, 'NOTE — DO NOT FEED', 'It does not guard the fuse because it understands doors. It guards it because the fuse is warm, and everything warm in this place belongs to it. Take it fast. Take it loud or take it quiet, but do not take it twice — you will not be offered the chance.');
    C(9, 107); C(35, 91);

    // ---- LEVEL 9 · EXIT EXPERIMENT
    P('medkit', 42, 92); P('ammo-ak', 64, 106); P('ammo-magnum', 50, 106); P('ammo-sniper', 45, 100); P('shells', 57, 92);
    P('ammo-missile', 54, 106); P('ammo-rocket', 41, 100);
    N(44, 92, 'NOTE — EXPERIMENT LOG 9', 'Day 40: the door opens both ways, which the Ethics Board considers a failure and I consider honesty. The entities avoid the observation glass. They are not afraid of us. They are afraid of being *known*. Keep them unknown. Keep moving.');
    N(63, 100, 'NOTE — FINAL PAGE', 'If you are reading this with a fuse in your pocket and a light in your hand, then the protocol worked exactly once. The exit is east. Forgive us the architecture.');
    N(45, 107, 'NOTE — CONTAINMENT 9-C', 'The projector in 9-C folds a cubic metre of space into a point the size of a grain of salt. It eats what it pulls. We never found what it ate. The console here drops the field. Three cells were charged. Use them the way you would use a last breath.');
    C(42, 107); C(64, 104);
    // ENDGAME · ANTI-MATTER PROJECTOR sealed in chamber 9-C (console unlocks it)
    P('weapon-antimatter', 62, 93); P('ammo-antimatter', 60, 91);

    // ---- Area 5 · LEVEL 4 ENTRANCE CACHE → .44 MAGNUM (the last argument)
    P('weapon-magnum', 58, 30); P('ammo-magnum', 59, 29);
    // M16 left behind in the east room of the exit wing
    P('weapon-m16', 62, 25); P('ammo-rifle', 63, 26);
    P('ammo-magnum', 63, 28); P('ammo-magnum', 57, 33);
    P('medkit', 58, 25); P('ammo-rifle', 59, 35); P('shells', 63, 35); P('ammo-smg', 58, 33);
    N(58, 28, 'NOTE — FINAL ENTRY', 'The exit needs the card AND the power. I have neither. If you\'re reading this holding both, then run, because it knows what the door means. It always knows. Don\'t look back at the threshold.');

    // ---- enemies
    E('stalker', 16, 12, [[16, 12], [7, 12], [7, 4], [16, 4]]);
    E('watcher', 17, 2, [], true); // scripted distant sighting
    E('runner', 26, 3, [[26, 3], [33, 9], [26, 14]]);
    E('runner', 40, 15, [[40, 15], [44, 8], [38, 13]]);
    E('stalker', 34, 9, [[34, 9], [27, 9], [43, 3], [43, 14]]);
    E('stalker', 18, 24, [[18, 24], [28, 24], [28, 35], [15, 35]]);
    E('heavy', 28, 33, [[28, 33], [24, 24], [30, 37]]);
    E('runner', 20, 36, [[20, 36], [8, 34], [14, 24]]);
    E('runner', 40, 36, [[40, 36], [46, 28], [52, 36]]);
    E('runner', 46, 22, [[46, 22], [40, 30], [44, 37]]);
    E('stalker', 44, 30, [[44, 30], [52, 28], [40, 22]]);
    E('watcher', 52, 36, [[52, 36], [48, 33]]);
    E('runner', 63, 33, [[63, 33], [58, 34], [59, 25]]);
    // ---- expansion encounters
    E('stalker', 14, 58, [[14, 58], [26, 48], [12, 48]]);           // L4 maintenance
    E('runner', 28, 60, [[28, 60], [18, 60], [24, 53]]);
    E('runner', 48, 52, [[48, 52], [56, 48], [44, 58]]);            // L5 flooded
    E('runner', 56, 58, [[56, 58], [48, 60], [60, 50]]);
    E('stalker', 50, 55, [[50, 55], [42, 49], [60, 59]]);
    E('stalker', 28, 72, [[28, 72], [22, 78], [33, 84]]);           // L6 office
    E('watcher', 33, 70, [[33, 70], [30, 75]]);
    E('runner', 18, 82, [[18, 82], [26, 84], [12, 76]]);
    E('watcher', 44, 70, [[44, 70], [50, 76]]);                     // L7 blackout
    E('stalker', 58, 82, [[58, 82], [50, 70], [64, 72]]);
    E('runner', 50, 70, [[50, 70], [44, 84], [60, 84]]);
    E('guardian', 22, 99, [[22, 99], [16, 103], [28, 96], [24, 106]]); // L8 the nest
    E('stalker', 30, 106, [[30, 106], [20, 92], [34, 96]]);
    E('runner', 14, 93, [[14, 93], [24, 104], [10, 104]]);
    E('heavy', 52, 104, [[52, 104], [44, 95], [60, 106]]);          // L9 experiment
    E('runner', 60, 101, [[60, 101], [50, 93], [64, 104]]);
    E('stalker', 45, 95, [[45, 95], [58, 100], [44, 106]]);
  }

  areaAt(pos: THREE.Vector3): AreaDef {
    const tx = worldToTile(pos.x);
    const ty = worldToTile(pos.z);
    for (const a of this.areas) {
      if (tx >= a.x0 - 2 && tx <= a.x1 + 2 && ty >= a.y0 - 2 && ty <= a.y1 + 2) return a;
    }
    // nearest by centre
    let best = this.areas[0];
    let bd = Infinity;
    for (const a of this.areas) {
      const cx = tileToWorld((a.x0 + a.x1) / 2);
      const cz = tileToWorld((a.y0 + a.y1) / 2);
      const d = (cx - pos.x) ** 2 + (cz - pos.z) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  // ---------------------------------------------------------- geometry
  private buildGeometry() {
    const rng = this.rng;
    const wallMats: Record<AreaDef['wall'], THREE.Material> = {
      yellow: new THREE.MeshStandardMaterial({ map: TX.wallpaperYellow(), roughness: 0.85, metalness: 0.02 }),
      service: new THREE.MeshStandardMaterial({ map: TX.wallpaperService(), roughness: 0.92, metalness: 0.02 }),
      facility: new THREE.MeshStandardMaterial({ map: TX.wallpaperFacility(), roughness: 0.88, metalness: 0.02 }),
    };
    const floorMats: Record<AreaDef['floor'], THREE.Material> = {
      carpet: new THREE.MeshStandardMaterial({ map: TX.carpetYellow(), roughness: 0.98 }),
      concrete: new THREE.MeshStandardMaterial({ map: TX.concreteFloor(), roughness: 0.94 }),
      dark: new THREE.MeshStandardMaterial({ map: TX.carpetDark(), roughness: 0.98 }),
    };
    const ceilMat = new THREE.MeshStandardMaterial({ map: TX.ceilingTile(), roughness: 0.95 });
    const pillarMat = new THREE.MeshStandardMaterial({ map: TX.wallpaperYellow(), roughness: 0.85, color: 0xbdb49a });

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const planeGeo = new THREE.PlaneGeometry(1, 1);

    // count instances
    const wallTiles: Record<string, [number, number][]> = { yellow: [], service: [], facility: [] };
    const cutTiles: Record<string, [number, number][]> = { yellow: [], service: [], facility: [] };
    const floorTiles: Record<string, [number, number][]> = { carpet: [], concrete: [], dark: [] };
    const ceilTiles: [number, number][] = [];
    const pillarTiles: [number, number][] = [];
    const m4 = new THREE.Matrix4();
    const q0 = new THREE.Quaternion();
    const col = new THREE.Color();

    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const t = this.tileAt(x, y);
        const wx = tileToWorld(x);
        const wz = tileToWorld(y);
        if (t === T_WALL) {
          // only render walls adjacent to floor (hidden ones skipped)
          let exposed = false;
          for (let dy = -1; dy <= 1 && !exposed; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (this.tileAt(x + dx, y + dy) !== T_WALL) { exposed = true; break; }
          if (!exposed) continue;
          const area = this.areaAt(new THREE.Vector3(wx, 0, wz));
          if (this.ductTiles.has(this.idx(x, y))) cutTiles[area.wall].push([x, y]);
          else wallTiles[area.wall].push([x, y]);
        } else {
          const area = this.areaAt(new THREE.Vector3(wx, 0, wz));
          floorTiles[area.floor].push([x, y]);
          ceilTiles.push([x, y]);
          if (t === T_PILLAR) {
            pillarTiles.push([x, y]);
            // the model is a 1.25 m box at the tile centre — collide with
            // THAT, not the whole 4 m tile
            this.obstacles.push({ minX: wx - 0.625, maxX: wx + 0.625, minZ: wz - 0.625, maxZ: wz + 0.625 });
            this.rayBoxes.push({ minX: wx - 0.625, maxX: wx + 0.625, minY: 0, maxY: WALL_H, minZ: wz - 0.625, maxZ: wz + 0.625 });
          }
        }
      }
    }

    const fillInstanced = (
      mat: THREE.Material, geo: THREE.BufferGeometry, tiles: [number, number][],
      make: (wx: number, wz: number) => { p: THREE.Vector3; s: THREE.Vector3; e?: THREE.Euler },
      jitter = 0.06,
      cast = false,
    ) => {
      if (tiles.length === 0) return;
      const im = new THREE.InstancedMesh(geo, mat, tiles.length);
      tiles.forEach(([tx, ty], i) => {
        const { p, s, e } = make(tileToWorld(tx), tileToWorld(ty));
        q0.setFromEuler(e ?? new THREE.Euler());
        m4.compose(p, q0, s);
        im.setMatrixAt(i, m4);
        const j = 1 - rng() * jitter;
        im.setColorAt(i, col.setRGB(j, j, j));
      });
      im.receiveShadow = true;
      im.castShadow = cast;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.group.add(im);
      return im;
    };

    (Object.keys(wallTiles) as AreaDef['wall'][]).forEach((k) => {
      fillInstanced(wallMats[k], boxGeo, wallTiles[k], (wx, wz) => ({
        p: new THREE.Vector3(wx, WALL_H / 2, wz), s: new THREE.Vector3(TILE, WALL_H, TILE),
      }), 0.10, true);
    });
    // walls a duct passes through: a lower block and a header with a notch
    // between them exactly where the duct runs (collision stays a full wall)
    (Object.keys(cutTiles) as AreaDef['wall'][]).forEach((k) => {
      fillInstanced(wallMats[k], boxGeo, cutTiles[k], (wx, wz) => ({
        p: new THREE.Vector3(wx, 2.27 / 2, wz), s: new THREE.Vector3(TILE, 2.27, TILE),
      }), 0.10, true);
      fillInstanced(wallMats[k], boxGeo, cutTiles[k], (wx, wz) => ({
        p: new THREE.Vector3(wx, (3.19 + WALL_H) / 2, wz), s: new THREE.Vector3(TILE, WALL_H - 3.19, TILE),
      }), 0.10, true);
    });
    (Object.keys(floorTiles) as AreaDef['floor'][]).forEach((k) => {
      const im = fillInstanced(floorMats[k], planeGeo, floorTiles[k], (wx, wz) => ({
        p: new THREE.Vector3(wx, 0, wz), s: new THREE.Vector3(TILE, TILE, 1), e: new THREE.Euler(-Math.PI / 2, 0, 0),
      }), 0.09);
      if (im) im.castShadow = false;
    });
    fillInstanced(ceilMat, planeGeo, ceilTiles, (wx, wz) => ({
      p: new THREE.Vector3(wx, WALL_H, wz), s: new THREE.Vector3(TILE, TILE, 1), e: new THREE.Euler(Math.PI / 2, 0, 0),
    }), 0.08);
    fillInstanced(pillarMat, boxGeo, pillarTiles, (wx, wz) => ({
      p: new THREE.Vector3(wx, WALL_H / 2, wz), s: new THREE.Vector3(1.25, WALL_H, 1.25),
    }), 0.05, true);

    this.buildProps(rng);
    this.buildDoors();
    this.buildPickupMeshes();
    this.buildNotesCrates();
    this.buildGenerators();
    this.buildLab();
    this.buildWaterMeshes();
    this.buildHazardCabinet();
    this.buildDecals(rng);
  }

  /** The sparking cabinet hazard in the flooded complex (visual only). */
  private buildHazardCabinet() {
    const g = new THREE.Group();
    g.position.copy(this.hazardPos);
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.9, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.6, metalness: 0.5 }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    const doorM = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.5, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x3a382f, roughness: 0.55, metalness: 0.5 }),
    );
    doorM.position.set(0.12, 0.95, 0.27);
    doorM.rotation.y = 0.7; // hanging open, guts exposed
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xbfe2ff }),
    );
    spark.position.set(0, 1.25, 0.2);
    spark.name = 'hazardSpark';
    g.add(body, doorM, spark);
    this.group.add(g);
    this.registerPropSolids(g, [body, doorM]);
  }

  /** Pulse the hazard spark (Game times the arcs). */
  setHazardGlow(on: boolean) {
    const s = this.group.getObjectByName('hazardSpark') as THREE.Mesh | undefined;
    if (s) (s.material as THREE.MeshBasicMaterial).color.setHex(on ? 0xeaf6ff : 0x36434c);
  }

  // Furniture is authored locally; the same parent matrix moves every part.
  private buildProps(rng: () => number) {
    const furniture = new FurnitureBuilder(this.propCollisions);
    const add = (kind: FurnitureKind, x: number, z: number, yaw: number, tipped = false) => {
      // Companion chairs and rotated shelves must stay clear of walls/doors.
      const root = furnitureTransform(kind, x, z, yaw, tipped);
      const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
      const bounds = new THREE.Box3();
      for (const p of FURNITURE_PARTS[kind]) bounds.union(unit.clone().applyMatrix4(root.clone().multiply(p.matrix)));
      for (let ty = worldToTile(bounds.min.z); ty <= worldToTile(bounds.max.z); ty++) {
        for (let tx = worldToTile(bounds.min.x); tx <= worldToTile(bounds.max.x); tx++) {
          if (this.tileAt(tx, ty) !== T_FLOOR || this.doorAt(tx, ty)) return false;
        }
      }
      furniture.add(kind, x, z, yaw, tipped);
      return true;
    };

    const spots: [number, number][] = [
      [4, 5], [6, 10], [15, 5], [7, 3], [17, 13], [12, 13],
      [26, 10], [39, 14], [33, 2], [43, 12], [28, 4],
      [5, 24], [9, 28], [20, 22], [26, 27], [15, 37], [30, 34], [8, 35],
      [41, 26], [47, 37], [44, 22], [59, 31], [63, 26],
      // expansion: maintenance benches, office cubicles, lab tables
      [22, 48], [28, 58], [10, 60],
      [14, 77], [18, 77], [24, 78], [26, 82], [28, 84], [30, 72], [33, 74],
      [10, 80], [12, 82], [14, 84], [28, 78], [17, 80],
      [43, 97], [54, 104], [62, 102], [52, 101],
    ];
    for (const [tx, ty] of spots) {
      if (this.tileAt(tx, ty) !== T_FLOOR) continue;
      const wx = tileToWorld(tx) + (rng() - 0.5) * 1.2;
      const wz = tileToWorld(ty) + (rng() - 0.5) * 1.2;
      const roll = rng();
      if (roll < 0.42) {
        const yaw = rng() * Math.PI;
        const placed = add('table', wx, wz, yaw);
        if (placed && rng() < 0.7) {
          const tipped = rng() < 0.35;
          const offset = new THREE.Vector3(0, 0, 1.24).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          if (!add('chair', wx + offset.x, wz + offset.z, yaw + Math.PI, tipped)) {
            add('chair', wx - offset.x, wz - offset.z, yaw, tipped);
          }
        }
      } else if (roll < 0.66) {
        add('shelf', wx, wz, Math.floor(rng() * 4) * Math.PI / 2);
      } else {
        add('chair', wx, wz, rng() * 3, rng() < 0.45);
      }
    }
    this.group.add(furniture.build());
  }

  private registerPropSolids(owner: THREE.Object3D, meshes: readonly THREE.Mesh[]) {
    owner.updateWorldMatrix(true, true);
    for (const mesh of meshes) this.propCollisions.addMesh(mesh, owner.uuid);
  }

  private buildDecals(rng: () => number) {
    // scattered papers
    const paperMat = new THREE.MeshBasicMaterial({ map: TX.paperTexture(7), transparent: false });
    const plane = new THREE.PlaneGeometry(0.32, 0.42);
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < 70; i++) {
      const tx = Math.floor(rng() * GW);
      const ty = Math.floor(rng() * GH);
      if (this.tileAt(tx, ty) === T_FLOOR) {
        spots.push(new THREE.Vector3(tileToWorld(tx) + (rng() - 0.5) * 3, 0.015 + i * 0.0004, tileToWorld(ty) + (rng() - 0.5) * 3));
      }
    }
    const im = new THREE.InstancedMesh(plane, paperMat, spots.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach((p, i) => {
      q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, rng() * Math.PI));
      m4.compose(p, q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    this.group.add(im);

    // blood pools near some enemy spawns
    const bloodMat = new THREE.MeshBasicMaterial({ map: TX.bloodTexture(), transparent: true, depthWrite: false });
    const bim = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.4, 2.4), bloodMat, this.enemySpawns.length);
    this.enemySpawns.forEach((s, i) => {
      const p = s.pos.clone();
      p.x += (rng() - 0.5) * 3; p.z += (rng() - 0.5) * 3; p.y = 0.02 + i * 0.0005;
      q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, rng() * Math.PI));
      m4.compose(p, q, new THREE.Vector3(1, 1, 1));
      bim.setMatrixAt(i, m4);
    });
    bim.instanceMatrix.needsUpdate = true;
    this.group.add(bim);
  }

  private buildDoors() {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.7, metalness: 0.4 });
    for (const d of this.doors) {
      const isExit = d.kind === 'exit' || d.kind === 'exit2';
      const tex = isExit ? TX.exitDoorTexture() : TX.doorTexture(d.kind !== 'normal');
      const slabMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.35 });
      const g = d.group;
      g.position.copy(d.pos);
      // frame posts fill tile sides
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.85, WALL_H, 0.5), frameMat);
      post.position.set(-1.6, WALL_H / 2, 0);
      const post2 = post.clone();
      post2.position.x = 1.6;
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(4, 0.55, 0.5), frameMat);
      lintel.position.set(0, WALL_H - 0.27, 0);
      g.add(post, post2, lintel);
      // orient the slab across the wall run: if walls are N/S of the door,
      // the wall runs north–south and the door group must rotate 90°
      const wallRunsNorthSouth = this.tileAt(d.tx, d.ty - 1) === T_WALL && this.tileAt(d.tx, d.ty + 1) === T_WALL;
      if (wallRunsNorthSouth) g.rotation.y = Math.PI / 2;

      if (isExit) {
        d.slab = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.9, 0.18), slabMat);
        d.slab.position.set(-0.6, 1.45, 0);
        d.slab2 = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.9, 0.18), slabMat);
        d.slab2.position.set(0.6, 1.45, 0);
        g.add(d.slab, d.slab2);
      } else {
        d.slab = new THREE.Mesh(new THREE.BoxGeometry(2.35, 2.9, 0.16), slabMat);
        d.slab.position.set(0, 1.45, 0);
        g.add(d.slab);
      }
      // keypad
      const kp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.1), frameMat);
      kp.position.set(1.42, 1.35, 0.3);
      g.add(kp);
      const lightMat = new THREE.MeshBasicMaterial({ color: d.kind === 'normal' ? 0x39d353 : 0xff2a1a });
      d.keypadLight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.05), lightMat);
      d.keypadLight.position.set(1.42, 1.44, 0.37);
      g.add(d.keypadLight);
      d.baseX = d.slab.position.x;
      d.slab.castShadow = true;
      this.group.add(g);

      // ---- exact hitboxes: the frame is solid even with the door open,
      // and the slab blocks precisely where it currently is, not by tile.
      const alongX = !wallRunsNorthSouth;
      for (const side of [-1.6, 1.6]) {
        if (alongX) {
          this.obstacles.push({ minX: d.pos.x + side - 0.425, maxX: d.pos.x + side + 0.425, minZ: d.pos.z - 0.25, maxZ: d.pos.z + 0.25 });
          this.rayBoxes.push({ minX: d.pos.x + side - 0.425, maxX: d.pos.x + side + 0.425, minY: 0, maxY: WALL_H, minZ: d.pos.z - 0.25, maxZ: d.pos.z + 0.25 });
        } else {
          this.obstacles.push({ minX: d.pos.x - 0.25, maxX: d.pos.x + 0.25, minZ: d.pos.z + side - 0.425, maxZ: d.pos.z + side + 0.425 });
          this.rayBoxes.push({ minX: d.pos.x - 0.25, maxX: d.pos.x + 0.25, minY: 0, maxY: WALL_H, minZ: d.pos.z + side - 0.425, maxZ: d.pos.z + side + 0.425 });
        }
      }
      // lintel header stops shots over the top of the doorway
      if (alongX) {
        this.rayBoxes.push({ minX: d.pos.x - 2, maxX: d.pos.x + 2, minY: WALL_H - 0.55, maxY: WALL_H, minZ: d.pos.z - 0.25, maxZ: d.pos.z + 0.25 });
      } else {
        this.rayBoxes.push({ minX: d.pos.x - 0.25, maxX: d.pos.x + 0.25, minY: WALL_H - 0.55, maxY: WALL_H, minZ: d.pos.z - 2, maxZ: d.pos.z + 2 });
      }
      const slabRec = (mesh: THREE.Mesh) => {
        this.doorSlabs.push({
          foot: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
          box: { minX: 0, maxX: 0, minY: 0, maxY: 2.9, minZ: 0, maxZ: 0 },
          mesh, door: d,
        });
      };
      slabRec(d.slab);
      const second = d.slab2;
      if (second) slabRec(second);
    }
    this.refreshDoorBoxes();
  }

  /** Recompute door slab hitboxes from the slabs' live animated positions. */
  private refreshDoorBoxes() {
    for (const s of this.doorSlabs) {
      const d = s.door;
      const geo = s.mesh.geometry as THREE.BoxGeometry;
      const halfW = (geo.parameters.width ?? 2.35) / 2;
      const halfD = (geo.parameters.depth ?? 0.16) / 2;
      const lx = s.mesh.position.x; // local offset along the slide axis
      let cx: number, cz: number, hx: number, hz: number;
      if (Math.abs(d.group.rotation.y) > 0.1) {
        // group rotated 90°: local +X runs along world −Z
        cx = d.pos.x; cz = d.pos.z - lx; hx = halfD; hz = halfW;
      } else {
        cx = d.pos.x + lx; cz = d.pos.z; hx = halfW; hz = halfD;
      }
      s.foot.minX = cx - hx; s.foot.maxX = cx + hx;
      s.foot.minZ = cz - hz; s.foot.maxZ = cz + hz;
      s.box.minX = s.foot.minX; s.box.maxX = s.foot.maxX;
      s.box.minZ = s.foot.minZ; s.box.maxZ = s.foot.maxZ;
    }
  }

  private buildPickupMeshes() {
    for (const p of this.pickups) {
      this.makePickupVisual(p);
      this.group.add(p.mesh);
    }
  }

  private makePickupVisual(p: PickupDef) {
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffc94d, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2c2e30, roughness: 0.45, metalness: 0.7 });
    {
      const g = p.mesh;
      g.position.copy(p.pos);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.42, 24), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(ring);
      const body = new THREE.Group();
      body.position.y = 0.55;
      g.add(body);
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        m.castShadow = true;
        body.add(m);
        return m;
      };
      switch (p.kind) {
        case 'ammo-pistol':
        case 'ammo-smg':
        case 'ammo-rifle': {
          const colr = p.kind === 'ammo-pistol' ? 0x706a3a : p.kind === 'ammo-smg' ? 0x3a5a70 : 0x51683a;
          add(new THREE.BoxGeometry(0.34, 0.16, 0.24), new THREE.MeshStandardMaterial({ color: colr, roughness: 0.6 }));
          add(new THREE.BoxGeometry(0.35, 0.05, 0.25), darkMetal, 0, 0.1, 0);
          break;
        }
        case 'ammo-ak': {
          // olive-drab lacquered steel case for 7.62×39
          add(new THREE.BoxGeometry(0.36, 0.15, 0.26), new THREE.MeshStandardMaterial({ color: 0x4a5a34, roughness: 0.6 }));
          add(new THREE.BoxGeometry(0.37, 0.045, 0.27), darkMetal, 0, 0.095, 0);
          add(new THREE.BoxGeometry(0.2, 0.012, 0.06), new THREE.MeshStandardMaterial({ color: 0x8a9040, roughness: 0.5 }), 0, 0.12, 0);
          break;
        }
        case 'ammo-sniper': {
          // slim match-grade box: five fat boat-tail rounds standing in a row
          add(new THREE.BoxGeometry(0.4, 0.13, 0.18), new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.45, metalness: 0.3 }));
          add(new THREE.BoxGeometry(0.41, 0.04, 0.19), darkMetal, 0, 0.085, 0);
          const tip = new THREE.MeshStandardMaterial({ color: 0xc8b060, roughness: 0.28, metalness: 0.9 });
          for (const rx of [-0.14, -0.07, 0, 0.07, 0.14]) {
            add(new THREE.CylinderGeometry(0.02, 0.023, 0.16, 10), tip, rx, 0.15, 0);
          }
          break;
        }
        case 'ammo-magnum': {
          // heavy-calibre carton: fat brass rounds standing proud of the box
          add(new THREE.BoxGeometry(0.34, 0.17, 0.24), new THREE.MeshStandardMaterial({ color: 0x5c2a14, roughness: 0.6 }));
          add(new THREE.BoxGeometry(0.35, 0.05, 0.25), darkMetal, 0, 0.11, 0);
          const bigRound = new THREE.MeshStandardMaterial({ color: 0xd0a244, roughness: 0.3, metalness: 0.85 });
          for (const rx of [-0.09, 0.0, 0.09]) {
            add(new THREE.CylinderGeometry(0.024, 0.024, 0.13, 10), bigRound, rx, 0.16, 0);
          }
          break;
        }
        case 'shells':
          add(new THREE.BoxGeometry(0.36, 0.14, 0.2), new THREE.MeshStandardMaterial({ color: 0x7a1f16, roughness: 0.55 }));
          add(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0xb03024, roughness: 0.4 }), -0.1, 0.12, 0);
          add(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0xb03024, roughness: 0.4 }), 0.02, 0.12, 0);
          add(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0xb03024, roughness: 0.4 }), 0.14, 0.12, 0);
          break;
        case 'medkit': {
          add(new THREE.BoxGeometry(0.42, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.5 }));
          const red = new THREE.MeshStandardMaterial({ color: 0xb01e1e, roughness: 0.5 });
          add(new THREE.BoxGeometry(0.2, 0.06, 0.07), red, 0, 0.11, 0);
          add(new THREE.BoxGeometry(0.07, 0.06, 0.2), red, 0, 0.11, 0);
          break;
        }
        case 'keycard': {
          const card = add(new THREE.BoxGeometry(0.3, 0.02, 0.2),
            new THREE.MeshStandardMaterial({ color: 0x18b7c4, roughness: 0.3, metalness: 0.4, emissive: 0x0a4a52, emissiveIntensity: 0.8 }), 0, 0, 0, -0.4, 0, 0.2);
          card.position.y = 0.1;
          (ringMat as THREE.MeshBasicMaterial).clone();
          break;
        }
        case 'goldkey': {
          const card = add(new THREE.BoxGeometry(0.3, 0.02, 0.2),
            new THREE.MeshStandardMaterial({ color: 0xd8a928, roughness: 0.25, metalness: 0.7, emissive: 0x5a3d05, emissiveIntensity: 0.9 }), 0, 0, 0, -0.4, 0, 0.2);
          card.position.y = 0.1;
          break;
        }
        case 'fuse': {
          // a fat ceramic core fuse, warm to the touch and faintly humming
          const ceramic = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.4 });
          const cap = new THREE.MeshStandardMaterial({ color: 0xb08030, roughness: 0.3, metalness: 0.85 });
          add(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 12), ceramic, 0, 0.1, 0, Math.PI / 2);
          add(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 10), cap, -0.17, 0.1, 0, Math.PI / 2);
          add(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 10), cap, 0.17, 0.1, 0, Math.PI / 2);
          add(new THREE.BoxGeometry(0.1, 0.05, 0.05),
            new THREE.MeshStandardMaterial({ color: 0x301a08, emissive: 0xff7722, emissiveIntensity: 1.6 }), 0, 0.1, 0);
          break;
        }
        case 'ammo-rocket':
        case 'ammo-missile': {
          // a single fat warhead (bazooka) or a twin missile pack (HL-4)
          const olive = new THREE.MeshStandardMaterial({ color: 0x4f5634, roughness: 0.6, metalness: 0.2 });
          const tip = new THREE.MeshStandardMaterial({ color: 0x8a8f86, roughness: 0.35, metalness: 0.7 });
          const count = p.kind === 'ammo-missile' ? 2 : 1;
          for (let i = 0; i < count; i++) {
            const ox = count === 2 ? (i === 0 ? -0.07 : 0.07) : 0;
            add(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 10), olive, ox, 0.05, 0, Math.PI / 2);
            add(new THREE.ConeGeometry(0.05, 0.12, 10), tip, ox, 0.05, -0.27, -Math.PI / 2);
          }
          break;
        }
        case 'ammo-antimatter': {
          // a containment cell: brass ends, a pocket of night in a glass vial
          add(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 14),
            new THREE.MeshStandardMaterial({ color: 0x6a5cff, transparent: true, opacity: 0.35, roughness: 0.05 }), 0, 0.1, 0);
          add(new THREE.SphereGeometry(0.045, 12, 12), new THREE.MeshBasicMaterial({ color: 0x000000 }), 0, 0.1, 0);
          add(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 14), darkMetal, 0, 0.23, 0);
          add(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 14), darkMetal, 0, -0.03, 0);
          break;
        }
        case 'weapon-bazooka': {
          const tube = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.65, metalness: 0.35 });
          add(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 12), tube, 0, 0.05, 0, Math.PI / 2);
          add(new THREE.CylinderGeometry(0.09, 0.06, 0.16, 12), darkMetal, 0, 0.05, 0.6, Math.PI / 2);
          add(new THREE.BoxGeometry(0.05, 0.16, 0.08), darkMetal, 0, -0.08, -0.1);
          body.rotation.y = 0.7;
          break;
        }
        case 'weapon-rocket': {
          add(new THREE.BoxGeometry(0.2, 0.2, 0.95), new THREE.MeshStandardMaterial({ color: 0x2d3033, roughness: 0.55, metalness: 0.45 }));
          add(new THREE.BoxGeometry(0.1, 0.08, 0.22), darkMetal, 0, 0.15, -0.05);
          add(new THREE.BoxGeometry(0.05, 0.16, 0.08), darkMetal, 0, -0.17, 0.1);
          body.rotation.y = 0.7;
          break;
        }
        case 'weapon-antimatter': {
          add(new THREE.BoxGeometry(0.16, 0.16, 0.7), darkMetal);
          add(new THREE.SphereGeometry(0.11, 16, 16), new THREE.MeshBasicMaterial({ color: 0x000000 }), 0, 0.02, -0.05);
          add(new THREE.TorusGeometry(0.15, 0.012, 8, 28),
            new THREE.MeshBasicMaterial({ color: 0x9a7cff }), 0, 0.02, -0.05);
          body.rotation.y = 0.7;
          break;
        }
        case 'weapon-magnum': {
          // revolver silhouette: frame, cylinder, barrel, rake grip
          add(new THREE.BoxGeometry(0.075, 0.1, 0.2), darkMetal, 0, 0, 0.02);
          add(new THREE.CylinderGeometry(0.036, 0.036, 0.078, 10), darkMetal, 0, -0.015, 0.012, Math.PI / 2);
          add(new THREE.CylinderGeometry(0.019, 0.019, 0.26, 10), darkMetal, 0, 0.022, -0.16, Math.PI / 2);
          add(new THREE.BoxGeometry(0.045, 0.11, 0.07), darkMetal, 0, -0.11, 0.07, -0.3);
          add(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 8), darkMetal, 0, 0.022, -0.29, Math.PI / 2);
          body.rotation.y = 0.7;
          break;
        }
        case 'weapon-ak':
        case 'weapon-m16':
        case 'weapon-sniper':
        case 'weapon-shotgun':
        case 'weapon-smg':
        case 'weapon-rifle': {
          // stylised long-gun silhouette (the sniper gets its scope)
          add(new THREE.BoxGeometry(0.09, 0.14, 0.85), darkMetal, 0, 0, 0);
          add(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), darkMetal, 0, 0.05, 0.6, Math.PI / 2);
          add(new THREE.BoxGeometry(0.07, 0.2, 0.16), darkMetal, 0, -0.14, 0.05);
          if (p.kind !== 'weapon-shotgun') add(new THREE.BoxGeometry(0.06, 0.26, 0.1), darkMetal, 0, -0.2, 0.18, 0.3);
          if (p.kind === 'weapon-sniper') {
            add(new THREE.CylinderGeometry(0.028, 0.028, 0.34, 10), darkMetal, 0, 0.17, -0.05, Math.PI / 2);
            add(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 10), darkMetal, 0, 0.17, -0.24, Math.PI / 2);
          }
          body.rotation.y = 0.7;
          break;
        }
      }
    }
  }

  /** Spawn a dynamic loot drop (from a slain entity). */
  addDrop(kind: PickupKind, pos: THREE.Vector3) {
    const p: PickupDef = {
      id: 5000 + this.pickups.length, kind,
      pos: pos.clone().setY(0), mesh: new THREE.Group(), taken: false,
    };
    this.pickups.push(p);
    this.makePickupVisual(p);
    this.group.add(p.mesh);
    this.interactables.push({
      id: 9000 + p.id, kind: 'pickup', pos: p.pos.clone().setY(0.8), radius: 2.3,
      label: () => `TAKE ${this.pickupLabel(p.kind)}`,
      available: () => !p.taken,
      interact: () => {
        if (this.hooks.pickupTaken(p)) this.removePickup(p);
      },
    });
  }

  pickupLabel(k: PickupKind): string {
    switch (k) {
      case 'ammo-pistol': return 'PISTOL AMMO ×8';
      case 'ammo-smg': return 'SMG AMMO ×24';
      case 'ammo-rifle': return 'RIFLE AMMO ×20';
      case 'ammo-magnum': return '.44 MAGNUM ROUNDS ×6';
      case 'ammo-ak': return '7.62×39 AMMO ×30';
      case 'ammo-sniper': return '.338 SNIPER ROUNDS ×5';
      case 'shells': return 'SHOTGUN SHELLS ×4';
      case 'medkit': return 'MEDKIT — PRESS Q TO USE';
      case 'keycard': return 'SECURITY KEYCARD';
      case 'goldkey': return 'GOLD SECURITY PASS';
      case 'fuse': return 'CORE FUSE — IT IS WARM';
      case 'weapon-shotgun': return 'PUMP SHOTGUN — SLOT 2';
      case 'weapon-smg': return 'SMG — SLOT 3';
      case 'weapon-rifle': return 'ASSAULT RIFLE — SLOT 4';
      case 'weapon-magnum': return '.44 MAGNUM — SLOT 5';
      case 'weapon-ak': return 'AK-47 — SLOT 6';
      case 'weapon-m16': return 'M16 — SLOT 7';
      case 'weapon-sniper': return 'L96 SNIPER RIFLE — SLOT 8';
      case 'weapon-bazooka': return 'M9 BAZOOKA — SLOT 9';
      case 'weapon-rocket': return 'HL-4 ROCKET LAUNCHER — SLOT 0';
      case 'weapon-antimatter': return 'ANTI-MATTER PROJECTOR — SLOT -';
      case 'ammo-rocket': return 'BAZOOKA ROCKET ×1';
      case 'ammo-missile': return 'HL-4 MISSILE PACK ×2';
      case 'ammo-antimatter': return 'ANTI-MATTER CELL ×1';
    }
  }

  /** The weapon cache planted at this area's entrance, if still unclaimed. */
  weaponInArea(area: AreaDef): PickupDef | undefined {
    return this.pickups.find((p) => {
      if (p.taken || !p.kind.startsWith('weapon-')) return false;
      const tx = worldToTile(p.pos.x);
      const ty = worldToTile(p.pos.z);
      return tx >= area.x0 && tx <= area.x1 && ty >= area.y0 && ty <= area.y1;
    });
  }

  private buildNotesCrates() {
    const noteMat = new THREE.MeshStandardMaterial({ map: TX.paperTexture(6), roughness: 0.9 });
    for (const n of this.notes) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.44), noteMat);
      m.rotation.x = -Math.PI / 2 + 0.12;
      m.rotation.z = this.rng() * Math.PI;
      m.position.copy(n.pos).add(new THREE.Vector3(0.3, 0.06, 0.2));
      n.mesh = m;
      this.group.add(m);
      // faint marker glint
      const glint = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.6),
        new THREE.MeshBasicMaterial({ map: TX.glowSprite(), color: 0xffe9a8, transparent: true, opacity: 0.10, depthWrite: false }));
      glint.rotation.x = -Math.PI / 2;
      glint.position.copy(m.position).setY(0.05);
      this.group.add(glint);
    }
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a5142, roughness: 0.8 });
    const crateEdge = new THREE.MeshStandardMaterial({ color: 0x38332a, roughness: 0.8 });
    for (const c of this.crates) {
      const g = new THREE.Group();
      g.position.copy(c.pos);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.85), crateMat);
      box.position.y = 0.43;
      box.castShadow = true;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.09, 0.9), crateEdge);
      lid.position.y = 0.9;
      g.add(box, lid);
      g.rotation.y = this.rng() * Math.PI;
      c.mesh = g;
      this.group.add(g);
      this.registerPropSolids(g, [box]);
    }
  }

  private buildGenerators() {
    this.buildGeneratorAt(this.generatorPos, 1);
    this.buildGeneratorAt(this.gen2Pos, 2);
    this.buildGeneratorAt(this.gen3Pos, 3);
    this.buildPumpStation();
  }

  private buildPumpStation() {
    const g = new THREE.Group();
    g.position.copy(this.pumpPos);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x2e4d5c, roughness: 0.55, metalness: 0.45 }));
    body.position.y = 0.5;
    body.castShadow = true;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.035, 8, 18),
      new THREE.MeshStandardMaterial({ color: 0xb03024, roughness: 0.45, metalness: 0.4 }));
    wheel.position.set(0, 0.72, 0.46);
    wheel.name = 'pumpWheel';
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    lamp.position.set(0.45, 0.92, 0.42);
    lamp.name = 'pumpLamp';
    g.add(body, wheel, lamp);
    this.group.add(g);
    this.registerPropSolids(g, [body]);
    this.controlOwners.set('pump', g.uuid);
  }

  /** Containment console + chamber 9-C with its glass column and pedestal. */
  private buildLab() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.4, metalness: 0.75 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.6, metalness: 0.5 });
    // console
    const c = new THREE.Group();
    c.position.copy(this.labConsolePos);
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.95, 0.7), steel);
    desk.position.y = 0.48;
    desk.castShadow = true;
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x050a10, emissive: 0x7a5cff, emissiveIntensity: 0.9 }));
    screen.position.set(0, 1.3, -0.2);
    screen.rotation.x = -0.25;
    screen.name = 'labScreen';
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xb01e1e, roughness: 0.4 }));
    lever.position.set(0.55, 1.1, 0.1);
    lever.rotation.x = 0.5;
    lever.name = 'labLever';
    c.add(desk, screen, lever);
    this.group.add(c);
    this.registerPropSolids(c, [desk, screen]);
    this.controlOwners.set('lab', c.uuid);
    // chamber: pedestal, glass column, conduit rings, a dormant violet light
    const ch = new THREE.Group();
    ch.position.copy(this.labChamberPos);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 0.35, 20), dark);
    base.position.y = 0.17;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.25, 20), dark);
    top.position.y = WALL_H - 0.12;
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, WALL_H - 0.6, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9a8cff, transparent: true, opacity: 0.14, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    glass.position.y = WALL_H / 2;
    ch.add(base, top, glass);
    for (const y of [0.6, 1.6, 2.6]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.025, 8, 32), steel);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      ch.add(ring);
    }
    this.labLight = new THREE.PointLight(0x8a5cff, 0, 12, 1.6);
    this.labLight.position.set(0, 1.4, 0);
    ch.add(this.labLight);
    this.group.add(ch);
    this.obstacles.push({ minX: this.labChamberPos.x - 0.25, maxX: this.labChamberPos.x + 0.25, minZ: this.labChamberPos.z - 0.25, maxZ: this.labChamberPos.z + 0.25 });
  }

  /** The containment shutdown sequence: console flips, the chamber wakes. */
  setLabUnlocked(on: boolean) {
    this.labUnlocked = on;
    const lever = this.group.getObjectByName('labLever');
    if (lever) lever.rotation.x = on ? -0.5 : 0.5;
    const screen = this.group.getObjectByName('labScreen') as THREE.Mesh | undefined;
    if (screen) (screen.material as THREE.MeshStandardMaterial).emissive.setHex(on ? 0x2aff7a : 0x7a5cff);
    if (!on) this.labLevel = 0;
  }

  setPumpsOn() {
    const lamp = this.group.getObjectByName('pumpLamp') as THREE.Mesh | undefined;
    if (lamp) (lamp.material as THREE.MeshBasicMaterial).color.setHex(0x2aff5a);
    const wheel = this.group.getObjectByName('pumpWheel');
    if (wheel) wheel.rotation.z = 1.2;
    this.setDrained(true);
  }

  private buildGeneratorAt(pos: THREE.Vector3, which: number) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6b5a26, roughness: 0.6, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x24261f, roughness: 0.7, metalness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.15, 0.95), bodyMat);
    body.position.y = 0.58;
    body.castShadow = true;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 0.8), dark);
    top.position.y = 1.24;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.06), dark);
    panel.position.set(0, 0.75, 0.51);
    const leverBase = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), dark);
    leverBase.position.set(-0.18, 0.82, 0.56);
    const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8),
      new THREE.MeshStandardMaterial({ color: 0xb01e1e, roughness: 0.4 }));
    lever.position.set(-0.18, 1.0, 0.58);
    lever.rotation.z = 0.5;
    lever.name = `lever${which}`;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    lamp.position.set(0.22, 0.88, 0.55);
    lamp.name = `genLamp${which}`;
    g.add(body, top, panel, leverBase, lever, lamp);
    this.group.add(g);
    this.registerPropSolids(g, [body, top, panel, leverBase]);
    this.controlOwners.set(`generator-${which}`, g.uuid);
  }

  setGeneratorOn(which: number) {
    const lamp = this.group.getObjectByName(`genLamp${which}`) as THREE.Mesh | undefined;
    if (lamp) (lamp.material as THREE.MeshBasicMaterial).color.setHex(0x2aff5a);
    const lever = this.group.getObjectByName(`lever${which}`);
    if (lever) lever.rotation.z = -0.5;
  }

  setGeneratorOff(which: number) {
    const lamp = this.group.getObjectByName(`genLamp${which}`) as THREE.Mesh | undefined;
    if (lamp) (lamp.material as THREE.MeshBasicMaterial).color.setHex(0xff2a1a);
    const lever = this.group.getObjectByName(`lever${which}`);
    if (lever) lever.rotation.z = 0.5;
  }

  // ---------------------------------------------------------- lights
  private buildLights() {
    // fixtures: emissive ceiling panels (instanced) + pooled real lights
    const panelGeo = new THREE.PlaneGeometry(1.7, 0.55);
    const positions: Fixture[] = [];
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (this.tileAt(x, y) !== T_FLOOR) continue;
        const area = this.areaAt(new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)));
        const step = area.lightEvery;
        if (x % step === 1 && y % step === 1) {
          // skip fixtures above duct tiles (they'd sit inside the ductwork)
          if (this.ductTiles.has(this.idx(x, y))) continue;
          const dead = this.rng() < area.darkFrac;
          positions.push({
            pos: new THREE.Vector3(tileToWorld(x), WALL_H - 0.02, tileToWorld(y)),
            seed: this.rng() * 100,
            dead,
            deadOrig: dead,
            area: area.id,
            level: 0,
          });
        }
      }
    }
    this.fixtures = positions;
    this.fixturePanelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.fixtureMesh = new THREE.InstancedMesh(panelGeo, this.fixturePanelMat, positions.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    const col = new THREE.Color(0x111111);
    positions.forEach((f, i) => {
      m4.compose(f.pos, q, new THREE.Vector3(1, 1, 1));
      this.fixtureMesh.setMatrixAt(i, m4);
      this.fixtureMesh.setColorAt(i, col);
    });
    this.fixtureMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.fixtureMesh);
    // housing boxes
    const housing = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.9, 0.09, 0.75),
      new THREE.MeshStandardMaterial({ color: 0x6e6a5c, roughness: 0.6, metalness: 0.4 }),
      positions.length,
    );
    positions.forEach((f, i) => {
      m4.compose(new THREE.Vector3(f.pos.x, WALL_H + 0.03, f.pos.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      housing.setMatrixAt(i, m4);
    });
    housing.instanceMatrix.needsUpdate = true;
    this.group.add(housing);

    // pool of 16 — Game.applySettings decides how many are actually live
    for (let i = 0; i < 16; i++) {
      const pl = new THREE.PointLight(0xffdf9e, 0, 19, 1.55);
      pl.position.set(0, -10, 0);
      this.group.add(pl);
      this.lights.push(pl);
    }
  }

  /** How many fluorescent point-lights are allowed to be live this frame. */
  setLightBudget(n: number) {
    this.lightBudget = clamp(Math.round(n), 1, this.lights.length);
    for (let i = this.lightBudget; i < this.lights.length; i++) {
      this.lights[i].intensity = 0;
      this.lights[i].position.set(0, -10, 0);
    }
  }

  /** Returns buzz source info for the audio engine. */
  buzzInfo(camPos: THREE.Vector3): { pos: THREE.Vector3; intensity: number } | null {
    let best: Fixture | null = null;
    let bd = Infinity;
    for (const f of this.fixtures) {
      if (f.dead) continue;
      const d = f.pos.distanceToSquared(camPos);
      if (d < bd) { bd = d; best = f; }
    }
    if (!best) return null;
    return { pos: best.pos, intensity: best.level };
  }

  /** Bring an area's dead fixtures back (G-4 restores the Blackout Zone). */
  restoreAreaLights(areaId: number) {
    for (const f of this.fixtures) {
      if (f.area === areaId && f.deadOrig) f.dead = f.seed % 10 < 1.5; // a few stay dead
    }
  }

  /** Area whose rectangle strictly contains the position (no margin), if any. */
  areaStrict(pos: THREE.Vector3): AreaDef | null {
    const tx = worldToTile(pos.x);
    const ty = worldToTile(pos.z);
    for (const a of this.areas) {
      if (tx >= a.x0 && tx <= a.x1 && ty >= a.y0 && ty <= a.y1) return a;
    }
    return null;
  }

  update(dt: number, camPos: THREE.Vector3) {
    this.fixtureTime += dt;
    this.pickupTime += dt;
    if (this.flickerEvent > 0) this.flickerEvent -= dt;
    // containment chamber wakes slowly after the console is used
    if (this.labLight) {
      this.labLevel = lerp(this.labLevel, this.labUnlocked ? 1 : 0, 1 - Math.pow(0.35, dt));
      this.labLight.intensity = this.labLevel * (16 + Math.sin(this.fixtureTime * 3.1) * 3);
    }

    // fixture levels
    const t = this.fixtureTime;
    const baseLevel = this.powerOn ? 1.0 : 0.82;
    for (const f of this.fixtures) {
      if (f.dead) { f.level = 0; continue; }
      let lvl = baseLevel;
      // unstable fixtures stutter
      const n = Math.sin(t * 31 + f.seed * 13.7) * Math.sin(t * 7.3 + f.seed);
      if (n > 0.965) lvl *= 0.25;
      else if (n > 0.93) lvl *= 0.6;
      if (this.flickerEvent > 0) {
        const d = f.pos.distanceTo(camPos);
        if (d < 26) lvl *= Math.random() < 0.5 ? 0.1 : 0.5;
      }
      f.level = lerp(f.level, lvl, 1 - Math.pow(0.0001, dt));
    }
    // write emissive colours for nearby fixtures
    const col = new THREE.Color();
    let dirty = false;
    for (let i = 0; i < this.fixtures.length; i++) {
      const f = this.fixtures[i];
      if (f.pos.distanceToSquared(camPos) > 1600) continue;
      const tint = this.areas[f.area]?.tint ?? 'warm';
      if (tint === 'cool') col.setRGB(0.68 * f.level, 0.8 * f.level, 1.05 * f.level);
      else if (tint === 'red') col.setRGB(1.05 * f.level, 0.38 * f.level, 0.26 * f.level);
      else col.setRGB(1.0 * f.level, 0.88 * f.level, 0.58 * f.level);
      this.fixtureMesh.setColorAt(i, col);
      dirty = true;
    }
    if (dirty && this.fixtureMesh.instanceColor) this.fixtureMesh.instanceColor.needsUpdate = true;

    // assign pooled point lights to brightest nearest fixtures
    const sorted = this.fixtures
      .filter((f) => !f.dead && f.pos.distanceToSquared(camPos) < 900)
      .sort((a, b) => a.pos.distanceToSquared(camPos) - b.pos.distanceToSquared(camPos))
      .slice(0, this.lightBudget);
    this.lights.forEach((pl, i) => {
      const f = sorted[i];
      if (f) {
        pl.position.copy(f.pos).y -= 0.35;
        pl.intensity = 26 * f.level;
        const tint = this.areas[f.area]?.tint ?? 'warm';
        pl.color.setHex(tint === 'cool' ? 0xd8e2ff : tint === 'red' ? 0xff5a3c : 0xffdf9e);
      } else {
        pl.intensity = 0;
      }
    });

    // doors
    for (const d of this.doors) {
      const prev = d.openness;
      d.openness = lerp(d.openness, d.target, 1 - Math.pow(0.002, dt));
      if (Math.abs(d.openness - d.target) < 0.01) d.openness = d.target;
      if (d.openness !== prev) {
        const slide = d.openness * 2.1;
        if (d.slab2) {
          d.slab.position.x = d.baseX - slide * 0.55;
          d.slab2.position.x = -d.baseX + slide * 0.55;
        } else {
          d.slab.position.x = d.baseX + slide;
        }
      }
      // keypad colour
      const access = this.hooks.doorAccess(d);
      const okCol = d.kind === 'exit' ? 0x2aff5a : 0x39d353;
      (d.keypadLight.material as THREE.MeshBasicMaterial).color.setHex(
        d.target === 1 ? 0x2aff5a : access === 'open' ? okCol : 0xff2a1a,
      );
    }
    this.refreshDoorBoxes();

    // pickups bob & spin
    for (const p of this.pickups) {
      if (p.taken) continue;
      const body = p.mesh.children[1];
      if (body) {
        body.position.y = 0.55 + Math.sin(this.pickupTime * 2 + p.id * 1.7) * 0.07;
        body.rotation.y += dt * 0.7;
      }
    }
  }

  triggerFlicker(dur = 0.7) {
    this.flickerEvent = Math.max(this.flickerEvent, dur);
  }

  removePickup(p: PickupDef) {
    p.taken = true;
    p.mesh.visible = false;
  }

  /** Restore doors, pickups, crates and generators to their initial state. */
  reset(state: { power: boolean; power2: boolean; power3: boolean; pumps: boolean; lab?: boolean }) {
    this.flickerEvent = 0;
    this.powerOn = state.power;
    this.power2On = state.power2;
    this.power3On = state.power3;
    this.setDrained(state.pumps);
    this.setLabUnlocked(!!state.lab);
    for (const f of this.fixtures) f.dead = f.deadOrig;
    if (state.power3) this.restoreAreaLights(BLACKOUT_AREA);
    for (const d of this.doors) {
      d.target = 0;
      d.openness = 0;
      d.slab.position.x = d.baseX;
      if (d.slab2) d.slab2.position.x = -d.baseX;
    }
    this.refreshDoorBoxes();
    // drop dynamic loot from previous run
    for (const p of this.pickups) {
      if (p.id >= 5000) this.group.remove(p.mesh);
    }
    this.pickups = this.pickups.filter((p) => p.id < 5000);
    this.interactables = this.interactables.filter((i) => i.id < 9000);
    for (const p of this.pickups) {
      p.taken = false;
      p.mesh.visible = true;
    }
    for (const c of this.crates) {
      c.looted = false;
      const lid = c.mesh.children[1];
      if (lid) {
        lid.rotation.set(0, 0, 0);
        lid.position.set(0, 0.9, 0);
      }
    }
    // restore every generator + pump station visual to match the save state
    const states: [number, boolean][] = [[1, state.power], [2, state.power2], [3, state.power3]];
    for (const [which, on] of states) {
      if (on) this.setGeneratorOn(which);
      else this.setGeneratorOff(which);
    }
    const pumpLamp = this.group.getObjectByName('pumpLamp') as THREE.Mesh | undefined;
    if (pumpLamp) (pumpLamp.material as THREE.MeshBasicMaterial).color.setHex(state.pumps ? 0x2aff5a : 0xff2a1a);
    const pumpWheel = this.group.getObjectByName('pumpWheel');
    if (pumpWheel) pumpWheel.rotation.z = state.pumps ? 1.2 : 0;
  }

  openCrate(c: CrateDef) {
    c.looted = true;
    const lid = c.mesh.children[1];
    if (lid) { lid.rotation.x = -0.9; lid.position.z -= 0.2; }
  }

  // ---------------------------------------------------------- interactables
  private buildInteractables() {
    let idc = 1;
    for (const d of this.doors) {
      if (d.kind === 'exit' || d.kind === 'exit2') {
        const isFinal = d.kind === 'exit2';
        this.interactables.push({
          id: idc++, kind: 'exit', pos: d.pos.clone().setY(1.3), radius: 2.6,
          label: () => {
            const a = this.hooks.doorAccess(d);
            if (d.target === 1) return 'THE WAY IS OPEN — GO';
            if (a !== 'open') return ACCESS_LABEL[a];
            return isFinal ? 'OPEN THE FINAL EXIT' : 'OPEN THE SERVICE DESCENT';
          },
          available: () => d.target === 0,
          interact: () => {
            const a = this.hooks.doorAccess(d);
            if (a === 'open') {
              d.target = 1;
              this.hooks.doorSound(d, true, false);
              this.hooks.exitOpened(d);
              this.hooks.onDoorOpened(d);
            } else {
              this.hooks.doorSound(d, false, true);
            }
          },
        });
        continue;
      }
      this.interactables.push({
        id: idc++, kind: 'door', pos: d.pos.clone().setY(1.3), radius: 2.4,
        label: () => {
          const a = this.hooks.doorAccess(d);
          if (d.target === 1) return 'CLOSE DOOR';
          if (a === 'open') return 'OPEN DOOR';
          return ACCESS_LABEL[a];
        },
        available: () => true,
        interact: () => {
          const now = performance.now();
          if ((this.doorInteractCooldown.get(d.id) ?? 0) > now) return;
          this.doorInteractCooldown.set(d.id, now + 350);
          if (d.target === 1) {
            d.target = 0;
            this.hooks.doorSound(d, false, false);
            return;
          }
          const a = this.hooks.doorAccess(d);
          if (a === 'open') {
            d.target = 1;
            this.hooks.doorSound(d, true, false);
            this.hooks.onDoorOpened(d);
          } else {
            this.hooks.doorSound(d, false, true);
          }
        },
      });
    }

    for (const p of this.pickups) {
      this.interactables.push({
        id: idc++, kind: p.kind.startsWith('weapon') ? 'weapon' : 'pickup', pos: p.pos.clone().setY(0.8), radius: 2.3,
        label: () => `TAKE ${this.pickupLabel(p.kind)}`,
        available: () => !p.taken,
        interact: () => {
          if (this.hooks.pickupTaken(p)) this.removePickup(p);
        },
      });
    }
    for (const n of this.notes) {
      this.interactables.push({
        id: idc++, kind: 'note', pos: n.pos.clone().setY(0.6), radius: 2.1,
        label: () => 'READ NOTE',
        available: () => true,
        interact: () => this.hooks.noteRead(n),
      });
    }
    for (const c of this.crates) {
      this.interactables.push({
        id: idc++, kind: 'crate', pos: c.pos.clone().setY(0.8), radius: 2.2,
        collisionOwner: c.mesh.uuid,
        label: () => (c.looted ? 'CRATE (EMPTY)' : 'SEARCH CRATE'),
        available: () => !c.looted,
        interact: () => {
          this.openCrate(c);
          this.hooks.crateLoot(c);
        },
      });
    }
    // generators (G-2 in the service maze, G-3 maintenance, G-4 blackout)
    const genDefs: { which: number; name: string; pos: THREE.Vector3; isOn: () => boolean; setOn: () => void }[] = [
      {
        which: 1, name: 'G-2', pos: this.generatorPos, isOn: () => this.powerOn,
        setOn: () => { this.powerOn = true; this.setGeneratorOn(1); },
      },
      {
        which: 2, name: 'G-3', pos: this.gen2Pos, isOn: () => this.power2On,
        setOn: () => { this.power2On = true; this.setGeneratorOn(2); },
      },
      {
        which: 3, name: 'G-4', pos: this.gen3Pos, isOn: () => this.power3On,
        setOn: () => { this.power3On = true; this.setGeneratorOn(3); },
      },
    ];
    for (const gd of genDefs) {
      this.interactables.push({
        id: idc++, kind: 'generator', pos: gd.pos.clone().setY(1.1), radius: 2.6,
        collisionOwner: this.controlOwners.get(`generator-${gd.which}`),
        label: () => (gd.isOn() ? `GENERATOR ${gd.name} — RUNNING` : `START GENERATOR ${gd.name}`),
        available: () => !gd.isOn(),
        interact: () => {
          if (gd.isOn()) return;
          gd.setOn();
          this.hooks.generatorActivated(gd.which);
        },
      });
    }
    // containment console (exit experiment)
    this.interactables.push({
      id: idc++, kind: 'generator', pos: this.labConsolePos.clone().setY(1.1), radius: 2.6,
      collisionOwner: this.controlOwners.get('lab'),
      label: () => (this.labUnlocked ? 'CONTAINMENT 9-C — DISENGAGED' : 'DISENGAGE CONTAINMENT 9-C'),
      available: () => !this.labUnlocked,
      interact: () => {
        if (this.labUnlocked) return;
        this.setLabUnlocked(true);
        this.hooks.labActivated();
      },
    });
    // drainage pumps (flooded complex)
    this.interactables.push({
      id: idc++, kind: 'generator', pos: this.pumpPos.clone().setY(1.1), radius: 2.6,
      collisionOwner: this.controlOwners.get('pump'),
      label: () => (this.pumpsDrained ? 'DRAINAGE PUMPS — RUNNING' : 'START DRAINAGE PUMPS'),
      available: () => !this.pumpsDrained,
      interact: () => {
        if (this.pumpsDrained) return;
        this.setPumpsOn();
        this.hooks.pumpActivated();
      },
    });
  }

  doorAt(tx: number, ty: number): Door | undefined {
    return this.doorMap.get(this.idx(tx, ty));
  }

  /** Force-open a door for an enemy (normal doors only). Returns true if opened. */
  enemyOpenDoor(d: Door): boolean {
    if (d.kind !== 'normal' || d.target === 1) return false;
    d.target = 1;
    this.hooks.doorSound(d, true, false);
    return true;
  }

  // ---------------------------------------------------------- queries
  /**
   * Solid tiles for movement: plain walls only. Pillars and doors collide
   * through their exact model boxes (rayBoxes / doorSlabs / obstacles),
   * because a 1.25 m pillar or a sliding 2.35 m slab is not a 4 m tile.
   */
  tileBlocked(tx: number, ty: number, _forEnemy = false): boolean {
    void _forEnemy;
    return this.tileAt(tx, ty) === T_WALL;
  }

  /** Push a circle out of an axis-aligned footprint (exact model boxes). */
  private resolveCircle(pos: THREE.Vector3, radius: number, minX: number, maxX: number, minZ: number, maxZ: number) {
    const cx = clamp(pos.x, minX, maxX);
    const cz = clamp(pos.z, minZ, maxZ);
    let dx = pos.x - cx;
    let dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius) return;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      pos.x = cx + (dx / d) * radius;
      pos.z = cz + (dz / d) * radius;
      return;
    }
    // centre inside the box: leave by the shallowest side
    const pl = pos.x - minX, pr = maxX - pos.x, pt = pos.z - minZ, pb = maxZ - pos.z;
    const m = Math.min(pl, pr, pt, pb);
    if (m === pl) pos.x = minX - radius;
    else if (m === pr) pos.x = maxX + radius;
    else if (m === pt) pos.z = minZ - radius;
    else pos.z = maxZ + radius;
  }

  /** Resolve circle-vs-world collision, mutating pos. */
  collide(pos: THREE.Vector3, radius: number, forEnemy = false, height = 1.8) {
    const tx = worldToTile(pos.x);
    const ty = worldToTile(pos.z);
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        if (!this.tileBlocked(x, y, forEnemy)) continue;
        this.resolveCircle(pos, radius, x * TILE, x * TILE + TILE, y * TILE, y * TILE + TILE);
      }
    }
    // props / crates / pillars / door frames — exact model footprints
    for (const o of this.obstacles) {
      this.resolveCircle(pos, radius, o.minX, o.maxX, o.minZ, o.maxZ);
    }
    this.propCollisions.collide(pos, radius, height);
    // sliding door slabs, wherever the animation currently has them
    for (const s of this.doorSlabs) {
      this.resolveCircle(pos, radius, s.foot.minX, s.foot.maxX, s.foot.minZ, s.foot.maxZ);
    }
    // keep inside world bounds
    pos.x = clamp(pos.x, TILE * 0.6, GW * TILE - TILE * 0.6);
    pos.z = clamp(pos.z, TILE * 0.6, GH * TILE - TILE * 0.6);
  }

  /** Exact ray-vs-AABB (slab method). Writes the entry-face normal; -1 = miss. */
  private rayBoxHit(o: THREE.Vector3, d: THREE.Vector3, b: RayBox, out: { nx: number; nz: number }): number {
    let tmin = 0;
    let tmax = Infinity;
    let nx = 0, nz = 0;
    if (Math.abs(d.x) < 1e-8) {
      if (o.x < b.minX || o.x > b.maxX) return -1;
    } else {
      let t1 = (b.minX - o.x) / d.x;
      let t2 = (b.maxX - o.x) / d.x;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; nx = d.x > 0 ? -1 : 1; nz = 0; }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    if (Math.abs(d.y) < 1e-8) {
      if (o.y < b.minY || o.y > b.maxY) return -1;
    } else {
      let t1 = (b.minY - o.y) / d.y;
      let t2 = (b.maxY - o.y) / d.y;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; nx = 0; nz = 0; }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    if (Math.abs(d.z) < 1e-8) {
      if (o.z < b.minZ || o.z > b.maxZ) return -1;
    } else {
      let t1 = (b.minZ - o.z) / d.z;
      let t2 = (b.maxZ - o.z) / d.z;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; nx = 0; nz = d.z > 0 ? -1 : 1; }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    if (tmin <= 0.001 || tmax < 0) return -1; // behind, or origin inside the box
    out.nx = nx;
    out.nz = nz;
    return tmin;
  }

  /**
   * Raycast: DDA over true wall tiles, then exact AABB tests against
   * pillars, door frames and the sliding door slabs — so bullets and
   * sight-lines stop where the models actually are.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignorePropOwner?: string): { dist: number; nx: number; nz: number; hit: boolean } {
    let best = maxDist;
    let hitAny = false;
    let bnx = 0, bnz = 0;
    let tx = worldToTile(origin.x);
    let ty = worldToTile(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-9));
    const tDeltaY = Math.abs(1 / (dir.z || 1e-9));
    const fracX = (origin.x - tx * TILE) / TILE;
    const fracY = (origin.z - ty * TILE) / TILE;
    let tMaxX = dir.x !== 0 ? (dir.x > 0 ? (1 - fracX) : fracX) * tDeltaX : Infinity;
    let tMaxY = dir.z !== 0 ? (dir.z > 0 ? (1 - fracY) : fracY) * tDeltaY : Infinity;
    // note: t here is in "per unit dir" — dir is normalised so t == distance / TILE-ish
    let t = 0;
    let nx = 0, nz = 0;
    const maxT = maxDist / TILE;
    for (let i = 0; i < 128; i++) {
      if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; nx = -stepX; nz = 0; }
      else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; nz = -stepY; nx = 0; }
      if (t > maxT) break;
      if (this.tileAt(tx, ty) === T_WALL) {
        best = t * TILE;
        hitAny = true;
        bnx = nx; bnz = nz;
        break;
      }
    }
    const face = { nx: 0, nz: 0 };
    const testBox = (b: RayBox) => {
      const bt = this.rayBoxHit(origin, dir, b, face);
      if (bt > 0 && bt < best) {
        best = bt;
        hitAny = true;
        bnx = face.nx; bnz = face.nz;
      }
    };
    for (const b of this.rayBoxes) testBox(b);
    for (const s of this.doorSlabs) testBox(s.box);
    const propHit = this.propCollisions.raycast(origin, dir, best, ignorePropOwner);
    if (propHit) {
      best = propHit.dist;
      bnx = propHit.nx; bnz = propHit.nz;
      hitAny = true;
    }
    return { dist: best, nx: bnx, nz: bnz, hit: hitAny };
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3, ignorePropOwner?: string): boolean {
    const dir = b.clone().sub(a);
    const dist = dir.length();
    if (dist < 0.001) return true;
    dir.normalize();
    const hit = this.raycast(a, dir, dist, ignorePropOwner);
    return !hit.hit || hit.dist >= dist - 0.05;
  }

  /** BFS path over tiles (enemy version: normal doors passable at cost). */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const sx = worldToTile(from.x), sy = worldToTile(from.z);
    const gx = worldToTile(to.x), gy = worldToTile(to.z);
    if (sx === gx && sy === gy) return [to.clone()];
    const key = (x: number, y: number) => y * GW + x;
    const prev = new Int32Array(GW * GH).fill(-1);
    const cost = new Float32Array(GW * GH).fill(Infinity);
    const inOpen = new Uint8Array(GW * GH);
    // Dijkstra (door cost) with array-based open list — grid is small
    const open: number[] = [key(sx, sy)];
    inOpen[key(sx, sy)] = 1;
    cost[key(sx, sy)] = 0;
    prev[key(sx, sy)] = key(sx, sy);
    const goal = key(gx, gy);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found = false;
    let guard = 0;
    while (open.length && guard++ < 6000) {
      // pop min cost
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (cost[open[i]] < cost[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) { found = true; break; }
      const cx = cur % GW, cy = Math.floor(cur / GW);
      for (const [dx, dy] of dirs) {
        const nx2 = cx + dx, ny2 = cy + dy;
        if (nx2 < 0 || ny2 < 0 || nx2 >= GW || ny2 >= GH) continue;
        const nk = key(nx2, ny2);
        const t = this.tileAt(nx2, ny2);
        if (t === T_WALL || t === T_PILLAR) continue;
        if (nk !== goal && this.propCollisions.overlapsCircle(tileToWorld(nx2), tileToWorld(ny2), 0.55)) continue;
        const door = this.doorMap.get(nk);
        if (door && door.kind !== 'normal') continue;
        const stepCost = door && door.closed ? 6 : 1;
        // avoid cutting corners through wall diagonals is N/A (4-dir)
        const nc = cost[cur] + stepCost;
        if (nc < cost[nk]) {
          cost[nk] = nc;
          prev[nk] = cur;
          if (!inOpen[nk]) { inOpen[nk] = 1; open.push(nk); }
        }
      }
    }
    if (!found && prev[goal] === -1) return [];
    // reconstruct
    const tiles: [number, number][] = [];
    let cur = goal;
    let safety = 0;
    while (cur !== key(sx, sy) && cur !== -1 && safety++ < 400) {
      tiles.push([cur % GW, Math.floor(cur / GW)]);
      cur = prev[cur];
    }
    tiles.reverse();
    // to world points + line-of-sight smoothing
    const pts: THREE.Vector3[] = tiles.map(([x, y]) => new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y)));
    pts.push(to.clone().setY(0));
    const smoothed: THREE.Vector3[] = [];
    let anchor = from.clone().setY(0);
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && (
        !this.lineOfSight(new THREE.Vector3(anchor.x, 1.2, anchor.z), new THREE.Vector3(pts[j].x, 1.2, pts[j].z)) ||
        !this.propCollisions.segmentClear(anchor, pts[j])
      )) j--;
      smoothed.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return smoothed;
  }

  randomFloorNear(pos: THREE.Vector3, minR: number, maxR: number): THREE.Vector3 | null {
    for (let tries = 0; tries < 24; tries++) {
      const tx = worldToTile(pos.x) + Math.floor((this.rng() - 0.5) * 2 * (maxR / TILE) * 2);
      const ty = worldToTile(pos.z) + Math.floor((this.rng() - 0.5) * 2 * (maxR / TILE) * 2);
      if (this.tileAt(tx, ty) !== T_FLOOR) continue;
      if (this.doorMap.has(this.idx(tx, ty))) continue;
      const p = new THREE.Vector3(tileToWorld(tx), 0, tileToWorld(ty));
      const d = p.distanceTo(pos);
      if (d >= minR && d <= maxR) return p;
    }
    return null;
  }
}
