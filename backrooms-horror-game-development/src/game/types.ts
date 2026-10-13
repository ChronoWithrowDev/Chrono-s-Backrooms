import * as THREE from 'three';

export const TILE = 4; // metres per grid tile
export const WALL_H = 3.4; // ceiling height

export type WeaponId =
  | 'pistol' | 'shotgun' | 'smg' | 'rifle' | 'magnum' | 'ak' | 'm16' | 'sniper'
  | 'bazooka' | 'rocket' | 'antimatter'
  | 'knife' | 'kitchen' | 'machete' | 'katana';

/** Headgear that occupies the inventory's goggle slot. */
export type GoggleKind = 'night' | 'thermal';

export interface InvWeaponRow {
  id: WeaponId;
  name: string;
  slotLabel: string;
  detail: string;
  current: boolean;
}

/** Everything the TAB inventory panel renders. */
export interface InventorySnapshot {
  weapons: InvWeaponRow[];
  goggles: { kind: GoggleKind; owned: boolean; equipped: boolean }[];
  goggleOn: boolean;
  medkits: number;
  health: number;
  hasKeycard: boolean;
  hasGold: boolean;
  hasFuse: boolean;
}

/** Anything the weapon raycast can wound: room entities and vent creatures. */
export interface DamageTarget {
  pos: THREE.Vector3;
  /** Horizontal body radius used by the hit spheres. */
  radius: number;
  /** Height of the "eyes" — the head-sphere centre derives from this. */
  eyeHeight: number;
  alive: boolean;
  isDead: boolean;
  applyDamage: (amount: number, part: 'head' | 'body', point: THREE.Vector3, dir: THREE.Vector3) => boolean;
}
/** Ammo consumable kinds, shared by world pickups and the weapon system. */
export type AmmoKind =
  | 'ammo-pistol' | 'ammo-smg' | 'ammo-rifle' | 'shells' | 'ammo-magnum' | 'ammo-ak' | 'ammo-sniper'
  | 'ammo-rocket' | 'ammo-missile' | 'ammo-antimatter';

/** Endgame ammunition: never in crates or random drops. */
export const RARE_AMMO: ReadonlySet<AmmoKind> = new Set<AmmoKind>(['ammo-rocket', 'ammo-missile', 'ammo-antimatter']);
export type EnemyKind = 'stalker' | 'runner' | 'watcher' | 'heavy' | 'guardian';
export type Phase = 'menu' | 'playing' | 'paused' | 'dead' | 'victory';
export type Quality =
  | 'lowest' | 'wimpy' | 'low' | 'medium' | 'high' | 'higher' | 'highest' | 'ultra' | 'explode';

export const QUALITY_ORDER: Quality[] = [
  'lowest', 'wimpy', 'low', 'medium', 'high', 'higher', 'highest', 'ultra', 'explode',
];

export const QUALITY_LABEL: Record<Quality, string> = {
  lowest: 'LOWEST',
  wimpy: 'WIMPY',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  higher: 'HIGHER',
  highest: 'HIGHEST',
  ultra: 'ULTRA',
  explode: 'DO YOU WANT YOUR PC TO EXPLODE',
};

/** Runtime knobs applied by Game.applySettings. */
export interface QualityPreset {
  /** Cap on devicePixelRatio. */
  pixelRatio: number;
  shadows: boolean;
  /** 0 = Basic, 1 = PCF, 2 = PCFSoft. */
  shadowType: 0 | 1 | 2;
  shadowMap: number;
  /** Particle / explosion multiplier. */
  effects: number;
  dust: boolean;
  /** How many pooled fluorescent point-lights are live. */
  lights: number;
  env: number;
  gunEnv: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  lowest:  { pixelRatio: 0.5,  shadows: false, shadowType: 0, shadowMap: 256,  effects: 0.2,  dust: false, lights: 2,  env: 0.06, gunEnv: 0.18 },
  wimpy:   { pixelRatio: 0.7,  shadows: false, shadowType: 0, shadowMap: 256,  effects: 0.35, dust: false, lights: 3,  env: 0.08, gunEnv: 0.22 },
  low:     { pixelRatio: 1.0,  shadows: false, shadowType: 0, shadowMap: 512,  effects: 0.5,  dust: false, lights: 4,  env: 0.10, gunEnv: 0.26 },
  medium:  { pixelRatio: 1.25, shadows: true,  shadowType: 1, shadowMap: 1024, effects: 0.8,  dust: true,  lights: 6,  env: 0.16, gunEnv: 0.38 },
  high:    { pixelRatio: 1.5,  shadows: true,  shadowType: 2, shadowMap: 1024, effects: 1.0,  dust: true,  lights: 7,  env: 0.18, gunEnv: 0.42 },
  higher:  { pixelRatio: 1.75, shadows: true,  shadowType: 2, shadowMap: 2048, effects: 1.2,  dust: true,  lights: 9,  env: 0.20, gunEnv: 0.48 },
  highest: { pixelRatio: 2.0,  shadows: true,  shadowType: 2, shadowMap: 2048, effects: 1.45, dust: true,  lights: 11, env: 0.22, gunEnv: 0.55 },
  ultra:   { pixelRatio: 2.5,  shadows: true,  shadowType: 2, shadowMap: 4096, effects: 1.8,  dust: true,  lights: 14, env: 0.26, gunEnv: 0.65 },
  explode: { pixelRatio: 3.5,  shadows: true,  shadowType: 2, shadowMap: 4096, effects: 2.6,  dust: true,  lights: 16, env: 0.32, gunEnv: 0.85 },
};

export interface Settings {
  sensitivity: number; // 0.3 .. 2.5
  volume: number; // 0 .. 1
  quality: Quality;
  headBob: boolean;
  invertY: boolean;
  fov: number; // 65 .. 95
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  volume: 0.8,
  quality: 'medium',
  headBob: true,
  invertY: false,
  fov: 75,
};

export interface SaveData {
  version: number;
  areaIndex: number;
  health: number;
  weapons: WeaponId[];
  currentWeapon: WeaponId;
  mags: Partial<Record<WeaponId, number>>;
  reserve: Partial<Record<WeaponId, number>>;
  hasKeycard: boolean;
  powerOn: boolean;
  kills: number;
  playTime: number;
  // expansion progression (optional so pre-expansion saves still load)
  hasGoldKey?: boolean;
  power2?: boolean;
  power3?: boolean;
  pumpsOn?: boolean;
  hasFuse?: boolean;
  labOn?: boolean;
  // goggles (optional so older saves still load)
  goggles?: GoggleKind[];
  goggleEq?: GoggleKind | null;
}

export interface GameStats {
  kills: number;
  shotsFired: number;
  shotsHit: number;
  timePlayed: number;
  areaName: string;
}

export interface UiCallbacks {
  onPhase: (phase: Phase, stats?: GameStats) => void;
  onObjective: (main: string, sub?: string) => void;
  onAreaBanner: (name: string, sub: string) => void;
  onNote: (title: string, body: string | null) => void;
  onToast: (text: string, warn?: boolean) => void;
  onInventory: (inv: InventorySnapshot | null) => void;
}

export type InteractKind = 'note' | 'pickup' | 'door' | 'generator' | 'crate' | 'exit' | 'weapon' | 'vent';

export interface Interactable {
  id: number;
  kind: InteractKind;
  pos: THREE.Vector3;
  radius: number;
  /** Ignore only this prop's own housing when checking its control prompt. */
  collisionOwner?: string;
  label: () => string;
  available: () => boolean;
  interact: () => void;
}

export interface NoiseEvent {
  pos: THREE.Vector3;
  radius: number;
  kind: 'shot' | 'sprint' | 'door' | 'land';
}

// tile helpers ------------------------------------------------------------
export const tileToWorld = (t: number) => t * TILE + TILE / 2;
export const worldToTile = (w: number) => Math.floor(w / TILE);

export function dist2D(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
