import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Settings, Phase, SaveData, GameStats, UiCallbacks, WeaponId, DamageTarget, AmmoKind, RARE_AMMO,
  GoggleKind, InventorySnapshot,
  Quality, QUALITY_ORDER, QUALITY_PRESETS,
  clamp, lerp, pick, rand, tileToWorld, worldToTile, WALL_H, DEFAULT_SETTINGS,
} from './types';
import { glowSprite } from './textures';
import { World, Door, PickupDef, NoteDef, CrateDef, DoorAccess, BLACKOUT_AREA } from './world';
import { Player, InputState } from './player';
import { WeaponSystem, WEAPONS, WEAPON_ORDER, MELEE_IDS, FireResult, AMMO_FOR_WEAPON, AMMO_PER_PICKUP, WeaponDef } from './weapons';
import { Enemy, spawnEnemies, EnemyContext } from './enemies';
import { VentSystem, VentFoothold, VentPortal, footholdPos, VENT_EYE } from './vents';
import { Crawler, VentStalker, VentMonster, VentMonsterContext } from './ventmonsters';
import { AudioEngine } from './audio';
import { Effects } from './effects';

const SAVE_KEY = 'backrooms-save-v1';
export const SETTINGS_KEY = 'backrooms-settings-v1';

const ENEMY_HEIGHT: Record<string, number> = { stalker: 2.6, runner: 1.35, watcher: 2.35, heavy: 2.5, guardian: 2.4 };

// area indices
const AREA_THRESHOLD = 4;
const AREA_L4 = 5;
const AREA_L5 = 6;
const AREA_L9 = 10;

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return data.version === 1 ? data : null;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const quality = QUALITY_ORDER.includes(parsed.quality as Quality) ? parsed.quality as Quality : DEFAULT_SETTINGS.quality;
      return { ...DEFAULT_SETTINGS, ...parsed, quality };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

export function storeSettings(s: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

type ProjectileKind = NonNullable<WeaponDef['projectile']>;
interface Projectile {
  kind: ProjectileKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Object3D;
  life: number;
  target: Enemy | null;
  trail: number;
}
interface Anomaly {
  pos: THREE.Vector3;
  age: number;
  life: number;
  radius: number;
  mesh: THREE.Group;
}
interface CrawlState extends VentFoothold {
  bob: number;
  moving: boolean;
  fast: boolean;
  stepAcc: number;
}

/** A shootable thing plus where its hit volumes sit. */
interface HitTarget {
  t: DamageTarget;
  baseY: number;
  height: number;
  headY: number;
  headR: number;
  bodyR: number;
}

export class Game {
  private container: HTMLElement;
  private ui: UiCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private gunScene = new THREE.Scene();
  private gunCamera!: THREE.PerspectiveCamera;
  private gunKey!: THREE.PointLight;
  private clock = new THREE.Clock();
  private world!: World;
  private player = new Player();
  private weapons!: WeaponSystem;
  private enemies: Enemy[] = [];
  private audio = new AudioEngine();
  private effects = new Effects();
  private settings: Settings;

  phase: Phase = 'menu';
  private input: InputState = { forward: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false };
  private keys = new Set<string>();
  private raf = 0;
  private disposed = false;

  // ---- progression
  private hasKeycard = false;
  private powerOn = false;
  private exitOpened = false;
  private finalWaveSpawned = false;
  private hasGoldKey = false;
  private power2On = false;
  private power3On = false;
  private pumpsOn = false;
  private hasFuse = false;
  private labOn = false;
  private finalOpened = false;
  private endWaveSpawned = false;
  private medkits = 1;
  private highestArea = 0;
  private currentAreaIdx = -1;
  private moodAreaIdx = -1;
  private stats: GameStats = { kills: 0, shotsFired: 0, shotsHit: 0, timePlayed: 0, areaName: '' };
  private sessionTime = 0;
  private runTimers = new Set<number>();
  /** Weapons that only exist because of the ` cheat — never written to saves. */
  private cheatGranted = new Set<WeaponId>();

  // ---- goggles & inventory
  private gogglesOwned = new Set<GoggleKind>();
  private goggleEquipped: GoggleKind | null = null;
  private goggleOn = false;
  private cheatGoggles = new Set<GoggleKind>();
  private invOpen = false;
  private cratesOpened = 0;
  private heatSprites: THREE.Sprite[] = [];
  private hemiLight!: THREE.HemisphereLight;
  private ambLight!: THREE.AmbientLight;

  // ---- ventilation
  private vents = new VentSystem();
  private ventMonsters: VentMonster[] = [];
  private crawl: CrawlState | null = null;
  private ventNoiseBurst = 0;
  private crawlCreakTimer = 3;
  private ventHintShown = false;
  private camTransition = 0;
  private camFrom = new THREE.Vector3();

  // ---- flooded-complex electrical hazard
  private hazardTimer = 4;
  private hazardCharging = false;

  // ---- heavy weapons
  private projectiles: Projectile[] = [];
  private anomalies: Anomaly[] = [];
  private anomalyLight!: THREE.PointLight;
  private protoMesh!: Record<ProjectileKind, THREE.Object3D>;
  private anomalyCoreGeo = new THREE.SphereGeometry(1, 24, 24);
  private anomalyCoreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private anomalyRimGeo = new THREE.TorusGeometry(1.15, 0.05, 8, 48);
  private anomalyRimMat = new THREE.MeshBasicMaterial({ color: 0xb08cff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  private anomalyHaloGeo = new THREE.SphereGeometry(1, 20, 20);
  private anomalyHaloMat = new THREE.MeshBasicMaterial({ color: 0x5a3cb0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
  private lockCandidate: Enemy | null = null;
  private lockTime = 0;
  private lockLost = 0;
  private lockedTarget: Enemy | null = null;

  // ---- fx state
  private trauma = 0;
  private damageFlash = 0;
  private damageDirAngle = 0;
  private damageDirTimer = 0;
  private hitmarkTimer = 0;
  private hitmarkKill = false;
  private healPool = 0;
  private healTimer = 0;
  private noteOpen = false;
  private buzzTimer = 0;
  private menuTime = 0;
  private alarmStop: (() => void) | null = null;
  private flashlight!: THREE.SpotLight;
  private flashOn = true;
  private flashFlicker = 0;
  private lastObjective = '';
  private interactTarget: { label: string; act: () => void } | null = null;
  private adsHeld = false;
  private saveFlashTimer = 0;

  private hudCache = new Map<string, string>();
  private areaSpawns: THREE.Vector3[] = [];
  private areaSpawnYaws: number[] = [];

  constructor(container: HTMLElement, ui: UiCallbacks, settings: Settings) {
    this.container = container;
    this.ui = ui;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.08, 300);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.fog = new THREE.FogExp2(0x0a0803, 0.03);
    this.scene.background = new THREE.Color(0x050403);

    // whisper-level image lighting so metals (and the gun) read in the dark
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.16;
    pmrem.dispose();

    // dedicated view-model pass: never clips into walls or duct sides
    this.gunCamera = new THREE.PerspectiveCamera(settings.fov, 1, 0.01, 12);
    this.gunCamera.rotation.order = 'YXZ';
    this.gunScene.add(this.gunCamera);
    this.gunScene.environment = envTex;
    this.gunScene.environmentIntensity = 0.38;
    this.gunScene.add(new THREE.HemisphereLight(0xa08c5e, 0x191008, 0.55));
    this.gunKey = new THREE.PointLight(0xffdfae, 2.4, 0, 1.4);
    this.gunKey.position.set(0.28, -0.05, -0.35);
    this.gunCamera.add(this.gunKey);
    const gunFill = new THREE.DirectionalLight(0xbfb49a, 0.85);
    gunFill.position.set(-0.4, 0.5, 0.25);
    this.gunCamera.add(gunFill);
    const gunFillTarget = new THREE.Object3D();
    gunFillTarget.position.set(0, -0.05, -1);
    this.gunCamera.add(gunFillTarget);
    gunFill.target = gunFillTarget;

    this.hemiLight = new THREE.HemisphereLight(0x9a8a5c, 0x14100a, 0.62);
    this.scene.add(this.hemiLight);
    this.ambLight = new THREE.AmbientLight(0x2a2113, 0.7);
    this.scene.add(this.ambLight);

    this.flashlight = new THREE.SpotLight(0xfff1d6, 0, 34, 0.52, 0.5, 1.1);
    this.flashlight.position.set(0.12, -0.1, 0.05);
    const flTarget = new THREE.Object3D();
    flTarget.position.set(0, -0.06, -6);
    this.camera.add(flTarget);
    this.flashlight.target = flTarget;
    this.camera.add(this.flashlight);

    // one persistent light for anomalies — adding/removing lights at runtime
    // forces shader recompiles (a visible hitch), so we only move this one
    this.anomalyLight = new THREE.PointLight(0x8a5cff, 0, 14, 1.6);
    this.anomalyLight.position.set(0, -50, 0);
    this.scene.add(this.anomalyLight);
    this.buildProjectilePrototypes();

    this.buildWorld();
    this.applySettings(settings);
    this.bindEvents();
    this.resize();
    this.spawnAllEnemies();
    this.player.spawn(this.world.playerSpawn, this.world.playerSpawnYaw);
    this.setMenuCamera(0);
    this.clock.start();
    this.loop();
  }

  // ======================================================== world setup
  private buildWorld() {
    this.world = new World({
      doorAccess: (d) => this.doorAccess(d),
      onDoorOpened: () => this.noiseEvent(this.player.pos, 7, false),
      pickupTaken: (p) => this.onPickup(p),
      noteRead: (n) => this.onNote(n),
      generatorActivated: (which) => this.onGenerator(which),
      pumpActivated: () => this.onPumps(),
      labActivated: () => this.onLab(),
      exitOpened: (d) => this.onExitOpened(d),
      crateLoot: (c) => this.onCrate(c),
      doorSound: (d, opening, denied) => this.audio.doorMove(opening, d.pos, denied),
    }, this.vents.ductTiles(70));
    this.scene.add(this.world.group);
    this.scene.add(this.effects.group);
    this.scene.add(this.vents.group);

    this.weapons = new WeaponSystem(this.gunCamera, {
      fireRay: (o, dir, range) => this.fireRay(o, dir, range),
      onShotFired: (w) => {
        this.stats.shotsFired++;
        this.trauma = Math.min(1, this.trauma + 0.06);
        if (this.crawl) {
          this.ventNoiseBurst = 1.4;
          const vp = footholdPos(this.crawl, new THREE.Vector3());
          for (const m of this.ventMonsters) this.monsterHear(m, vp, 30, true);
        } else {
          this.noiseEvent(this.player.pos, WEAPONS[w].noiseRadius, true);
        }
      },
      applyRecoil: (p, y) => {
        this.player.pitch = clamp(this.player.pitch + p, -1.45, 1.45);
        this.player.yaw += y;
      },
      onHit: (kill) => this.markHit(kill),
      launch: (kind, origin, dir) => this.launchProjectile(kind, origin, dir),
      canFire: (def) => {
        if (this.crawl && def.projectile) {
          this.ui.onToast('NO ROOM TO FIRE THAT IN A DUCT', true);
          return false;
        }
        return true;
      },
    }, this.audio, this.effects);
    this.weapons.onAmmoChanged = () => this.pushInventory();

    // checkpoints sit just inside each level's entrance
    const T = (x: number, y: number) => new THREE.Vector3(tileToWorld(x), 0, tileToWorld(y));
    this.areaSpawns = [
      this.world.playerSpawn.clone(), T(25, 9), T(30, 21), T(38, 30), T(57, 30),
      T(33, 54), T(39, 58), T(30, 69), T(41, 77), T(35, 98), T(41, 104),
    ];
    const E = -Math.PI / 2, W = Math.PI / 2, S = Math.PI;
    this.areaSpawnYaws = [E, E, S, E, E, W, E, S, E, W, E];

    this.player.onStep = (running, crouched) => {
      const wet = this.world.waterAt(this.player.pos);
      if (wet > 0) this.audio.splashStep();
      else this.audio.footstep(running, crouched);
      const r = this.player.noiseRadius() * (wet > 0 ? 1.5 : 1);
      if (r > 0) this.noiseEvent(this.player.pos, r, running);
    };
    this.player.onLand = (hard) => {
      this.audio.jumpLand();
      if (hard) this.noiseEvent(this.player.pos, 11, false);
    };
  }

  private buildProjectilePrototypes() {
    const olive = new THREE.MeshStandardMaterial({ color: 0x5d6640, roughness: 0.5, metalness: 0.4 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.8 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffb35a });
    const mk = (body: THREE.Material, r: number, len: number): THREE.Object3D => {
      const g = new THREE.Group();
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), body);
      tube.rotation.x = Math.PI / 2;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(r, len * 0.4, 10), body);
      nose.rotation.x = -Math.PI / 2;
      nose.position.z = -len * 0.7;
      const flame = new THREE.Mesh(new THREE.SphereGeometry(r * 0.9, 8, 8), glow);
      flame.position.z = len * 0.55;
      g.add(tube, nose, flame);
      return g;
    };
    const orb = new THREE.Group();
    orb.add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), new THREE.MeshBasicMaterial({ color: 0x000000 })));
    orb.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x9a6cff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
    this.protoMesh = { bazooka: mk(olive, 0.07, 0.5), rocket: mk(steel, 0.05, 0.4), antimatter: orb };
  }

  private spawnAllEnemies() {
    for (const e of this.enemies) {
      this.scene.remove(e.group);
      e.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      e.dispose();
    }
    this.enemies = spawnEnemies(this.world, this.audio);
    for (const e of this.enemies) this.scene.add(e.group);
    this.finalWaveSpawned = false;
    this.endWaveSpawned = false;
    this.spawnVentMonsters();
    this.attachHeatSprites();
  }

  /** Thermal-vision heat blooms, parented to every entity (hidden unless thermal is on). */
  private attachHeatSprites() {
    this.heatSprites = [];
    const tex = glowSprite();
    const add = (group: THREE.Group, h: number, w: number) => {
      if (group.children.some((c) => c.name === 'heat')) return;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0xff7226, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.name = 'heat';
      s.scale.set(w, h * 0.92, 1);
      s.position.y = h * 0.48;
      s.visible = this.goggleOn && this.goggleEquipped === 'thermal';
      group.add(s);
      this.heatSprites.push(s);
    };
    for (const e of this.enemies) add(e.group, ENEMY_HEIGHT[e.kind] ?? 2.2, e.kind === 'guardian' || e.kind === 'heavy' ? 2.4 : 1.4);
    for (const m of this.ventMonsters) add(m.group, m.heightTotal, 1.1);
  }

  private spawnVentMonsters() {
    for (const m of this.ventMonsters) {
      this.scene.remove(m.group);
      m.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      m.dispose();
    }
    const nets = this.vents.networks;
    this.ventMonsters = [
      new Crawler(nets[0], 2, this.audio), // maintenance ducts — first encounter
      new Crawler(nets[1], 4, this.audio), // flood bypass — the shortcut has a price
      new VentStalker(nets[2], 5, this.audio), // office ceiling roads
      new Crawler(nets[3], 3, this.audio), // nest warren
    ];
    for (const m of this.ventMonsters) this.scene.add(m.group);
    for (const p of this.vents.portals) {
      p.grateOpen = false;
      p.bashTime = 0;
    }
  }

  private clearHeavyFx() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const a of this.anomalies) this.scene.remove(a.mesh);
    this.projectiles = [];
    this.anomalies = [];
    this.anomalyLight.intensity = 0;
    this.lockCandidate = null;
    this.lockedTarget = null;
    this.lockTime = 0;
  }

  private scheduleForRun(callback: () => void, delay: number) {
    const timer = window.setTimeout(() => {
      this.runTimers.delete(timer);
      if (!this.disposed) callback();
    }, delay);
    this.runTimers.add(timer);
  }

  private cancelRunTimers() {
    for (const timer of this.runTimers) window.clearTimeout(timer);
    this.runTimers.clear();
  }

  private resetRun(save: SaveData | null) {
    this.cancelRunTimers();
    this.audio.reset();
    const state = {
      power: save?.powerOn ?? false,
      power2: save?.power2 ?? false,
      power3: save?.power3 ?? false,
      pumps: save?.pumpsOn ?? false,
      lab: save?.labOn ?? false,
    };
    this.world.reset(state);
    this.powerOn = state.power;
    this.power2On = state.power2;
    this.power3On = state.power3;
    this.pumpsOn = state.pumps;
    this.labOn = state.lab;
    if (state.power || state.power2 || state.power3) this.audio.startGeneratorHum();
    this.hasKeycard = save?.hasKeycard ?? false;
    this.hasGoldKey = save?.hasGoldKey ?? false;
    this.hasFuse = save?.hasFuse ?? false;
    this.exitOpened = false;
    this.finalOpened = false;
    this.cheatGranted.clear();
    // goggles restore (validated against the known kinds)
    this.cheatGoggles.clear();
    this.gogglesOwned = new Set((save?.goggles ?? []).filter((k): k is GoggleKind => k === 'night' || k === 'thermal'));
    this.goggleEquipped = save?.goggleEq && this.gogglesOwned.has(save.goggleEq) ? save.goggleEq : null;
    this.goggleOn = false;
    this.applyGoggleVision();
    this.cratesOpened = 0;
    if (this.invOpen) { this.invOpen = false; this.ui.onInventory(null); }
    this.exitCrawl(null, true);
    this.clearHeavyFx();
    if (this.alarmStop) { this.alarmStop(); this.alarmStop = null; }
    this.medkits = 1;
    this.healPool = 0;
    this.trauma = 0;
    this.hazardTimer = 4;
    this.spawnAllEnemies();

    const areaIdx = clamp(save?.areaIndex ?? 0, 0, this.areaSpawns.length - 1);
    this.highestArea = areaIdx;
    this.currentAreaIdx = -1;
    this.moodAreaIdx = -1;
    this.player.spawn(this.areaSpawns[areaIdx], this.areaSpawnYaws[areaIdx]);
    if (save) {
      this.player.health = clamp(save.health, 30, 100);
      this.stats.kills = save.kills;
      this.sessionTime = save.playTime;
      this.weapons.restore({ owned: save.weapons, current: save.currentWeapon, mags: save.mags, reserve: save.reserve });
    } else {
      this.stats = { kills: 0, shotsFired: 0, shotsHit: 0, timePlayed: 0, areaName: '' };
      this.sessionTime = 0;
      this.weapons.restore({
        owned: ['pistol'], current: 'pistol',
        mags: Object.fromEntries(WEAPON_ORDER.map((id) => [id, id === 'pistol' ? 12 : 0])),
        reserve: Object.fromEntries(WEAPON_ORDER.map((id) => [id, id === 'pistol' ? 36 : 0])),
      });
    }
    this.closeNote();
    this.noteOpen = false;
    this.updateObjective(true);
  }

  // ======================================================== public API
  startNewGame() {
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    this.resetRun(null);
    this.enterPlaying();
    this.ui.onAreaBanner(this.world.areas[0].name, this.world.areas[0].sub);
    this.ui.onToast('P229 HANDGUN — SLOT 1 · 36 SPARE ROUNDS');
    this.ui.onToast('Find a way out. Trust nothing that stands still.');
  }

  continueGame() {
    const save = loadSave();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.resetRun(save);
    this.enterPlaying();
    const area = this.world.areas[this.highestArea];
    if (area) this.ui.onAreaBanner(area.name, area.sub);
    this.ui.onToast('Checkpoint restored. It remembers you.');
  }

  restartFromCheckpoint() {
    this.audio.init();
    this.resetRun(loadSave());
    this.enterPlaying();
  }

  pauseGame() {
    if (this.phase !== 'playing') return;
    this.setPhase('paused');
    document.exitPointerLock();
  }

  resumeGame() {
    if (this.phase !== 'paused') return;
    this.audio.init();
    this.setPhase('playing');
    this.lockPointer();
  }

  quitToMenu() {
    this.cancelRunTimers();
    this.audio.reset();
    if (this.alarmStop) { this.alarmStop(); this.alarmStop = null; }
    this.closeNote();
    this.noteOpen = false;
    this.exitCrawl(null, true);
    this.clearHeavyFx();
    this.world.reset({ power: false, power2: false, power3: false, pumps: false, lab: false });
    this.powerOn = this.power2On = this.power3On = this.pumpsOn = this.labOn = false;
    this.hasKeycard = this.hasGoldKey = this.hasFuse = false;
    this.exitOpened = this.finalOpened = false;
    this.gogglesOwned.clear();
    this.cheatGoggles.clear();
    this.goggleEquipped = null;
    this.goggleOn = false;
    this.applyGoggleVision();
    if (this.invOpen) { this.invOpen = false; this.ui.onInventory(null); }
    this.spawnAllEnemies();
    this.player.spawn(this.world.playerSpawn, this.world.playerSpawnYaw);
    this.setPhase('menu');
    document.exitPointerLock();
  }

  applySettings(s: Settings) {
    this.settings = s;
    this.audio.setVolume(s.volume);
    this.player.headBobEnabled = s.headBob;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    const preset = QUALITY_PRESETS[s.quality] ?? QUALITY_PRESETS.medium;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(dpr, preset.pixelRatio));
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = preset.shadowType === 2
      ? THREE.PCFSoftShadowMap
      : preset.shadowType === 1
        ? THREE.PCFShadowMap
        : THREE.BasicShadowMap;
    this.flashlight.castShadow = preset.shadows;
    if (preset.shadows) this.flashlight.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    this.effects.setQuality(preset.effects);
    this.effects.setDust(preset.dust);
    this.world.setLightBudget(preset.lights);
    this.scene.environmentIntensity = preset.env;
    this.gunScene.environmentIntensity = preset.gunEnv;
    if (this.flashlight.shadow.map) {
      this.flashlight.shadow.map.dispose();
      this.flashlight.shadow.map = null;
    }
    this.resize();
  }

  private enterPlaying() {
    this.setPhase('playing');
    this.lockPointer();
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.ui.onPhase(p, { ...this.stats, timePlayed: this.sessionTime, areaName: this.world.areas[Math.max(0, this.currentAreaIdx)]?.name ?? 'LEVEL 0' });
    if (p !== 'playing') {
      this.weapons?.setTrigger(false);
      this.adsHeld = false;
      if (this.invOpen) { this.invOpen = false; this.ui.onInventory(null); }
      this.audio.setDanger(0);
      for (const e of this.enemies) e.silence();
      for (const m of this.ventMonsters) m.silence();
    } else {
      this.hudCache.clear();
    }
  }

  private lockPointer() {
    const el = this.renderer.domElement;
    try {
      const r = el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch { /* browser cooldown */ }
  }

  // ======================================================== progression
  private doorAccess(d: Door): DoorAccess {
    switch (d.kind) {
      case 'normal': return 'open';
      case 'keycard': return this.hasKeycard ? 'open' : 'need-keycard';
      case 'power': return this.powerOn ? 'open' : 'need-power';
      case 'exit':
        if (this.hasKeycard && this.powerOn) return 'open';
        if (!this.hasKeycard && !this.powerOn) return 'need-both';
        return this.hasKeycard ? 'need-power' : 'need-keycard';
      case 'p2': return this.power2On ? 'open' : 'need-p2';
      case 'pumps': return this.pumpsOn ? 'open' : 'need-pumps';
      case 'gold': return this.hasGoldKey ? 'open' : 'need-gold';
      case 'p3': return this.power3On ? 'open' : 'need-p3';
      case 'fuse': return this.hasFuse ? 'open' : 'need-fuse';
      case 'lab': return this.labOn ? 'open' : 'need-lab';
      case 'exit2': return 'open';
    }
  }

  private onPickup(p: PickupDef): boolean {
    const k = p.kind;
    if (k in AMMO_PER_PICKUP) {
      const ammo = k as AmmoKind;
      if (!this.weapons.addAmmo(ammo, AMMO_PER_PICKUP[ammo])) {
        this.ui.onToast('AMMUNITION FULL', true);
        return false;
      }
      this.audio.pickup();
      return true;
    }
    switch (k) {
      case 'medkit':
        if (this.medkits >= 4) { this.ui.onToast('MEDKIT POUCH FULL', true); return false; }
        this.medkits++;
        this.audio.pickup();
        this.ui.onToast(`MEDKIT STORED — ${this.medkits} (Q TO USE)`);
        return true;
      case 'keycard':
        this.hasKeycard = true;
        this.audio.keycard();
        this.ui.onToast('SECURITY KEYCARD ACQUIRED');
        this.updateObjective();
        this.writeSave();
        return true;
      case 'goldkey':
        this.hasGoldKey = true;
        this.audio.keycard();
        this.ui.onToast('GOLD SECURITY PASS ACQUIRED — THE EAST GATE WILL OPEN');
        this.updateObjective();
        this.writeSave();
        return true;
      case 'fuse':
        this.hasFuse = true;
        this.audio.keycard();
        this.ui.onToast('CORE FUSE TAKEN — IT IS STILL WARM. SO IS SOMETHING ELSE.', true);
        // taking the fuse wakes the nest
        for (const e of this.enemies) if (e.kind === 'guardian') e.hearNoise(this.player.pos, 200, true);
        this.updateObjective();
        this.writeSave();
        return true;
      default: {
        if (k.startsWith('weapon-')) {
          const id = k.replace('weapon-', '') as WeaponId;
          this.weapons.giveWeapon(id);
          this.cheatGranted.delete(id); // found for real now — it may be saved
          this.weapons.select(id);
          this.audio.pickup();
          this.ui.onToast(`${WEAPONS[id].name} ACQUIRED — SLOT ${WEAPONS[id].slot > 9 ? (WEAPONS[id].slot === 10 ? 0 : '-') : WEAPONS[id].slot}`);
          if (id === 'antimatter') {
            this.world.triggerFlicker(1.2);
            this.audio.stinger(0.6);
          }
          return true;
        }
        return false;
      }
    }
  }

  private onNote(n: NoteDef) {
    this.noteOpen = true;
    this.audio.noteOpen();
    this.ui.onNote(n.title, n.body);
  }

  closeNote() {
    if (!this.noteOpen) return;
    this.noteOpen = false;
    this.ui.onNote('', null);
  }

  private onGenerator(which: number) {
    const name = which === 1 ? 'G-2' : which === 2 ? 'G-3' : 'G-4';
    if (which === 1) this.powerOn = true;
    if (which === 2) this.power2On = true;
    if (which === 3) {
      this.power3On = true;
      this.world.restoreAreaLights(BLACKOUT_AREA);
    }
    this.audio.generatorStart();
    this.scheduleForRun(() => {
      this.audio.startGeneratorHum();
      this.audio.powerSurge();
      this.world.triggerFlicker(0.8);
    }, 1300);
    this.ui.onToast(`GENERATOR ${name} ONLINE — POWER RESTORED`);
    this.updateObjective();
    this.writeSave();
  }

  private onPumps() {
    this.pumpsOn = true;
    this.audio.generatorStart();
    this.ui.onToast('DRAINAGE PUMPS RUNNING — THE WATER IS FALLING');
    this.updateObjective();
    this.writeSave();
  }

  private onLab() {
    this.labOn = true;
    // the surrounding machinery powers down; the chamber wakes
    this.world.triggerFlicker(2.2);
    this.audio.powerSurge();
    this.scheduleForRun(() => this.audio.stinger(0.5), 700);
    this.ui.onToast('CONTAINMENT 9-C DISENGAGED — THE CHAMBER IS AWAKE');
    this.updateObjective();
    this.writeSave();
  }

  private spawnWave(list: { kind: Enemy['kind']; x: number; y: number }[]) {
    for (const s of list) {
      const pos = new THREE.Vector3(tileToWorld(s.x), 0, tileToWorld(s.y));
      const e = new Enemy({ kind: s.kind, pos, patrol: [pos.clone()] }, this.audio);
      e.hearNoise(this.player.pos, 200, true);
      this.enemies.push(e);
      this.scene.add(e.group);
    }
    this.attachHeatSprites();
  }

  private onExitOpened(d: Door) {
    this.world.triggerFlicker(1.4);
    this.audio.stinger(1);
    if (this.alarmStop) this.alarmStop();
    this.alarmStop = this.audio.alarmLoop();
    if (d.kind === 'exit2') {
      this.finalOpened = true;
      this.ui.onToast('THE EXPERIMENT ENDS HERE — RUN', true);
      if (!this.endWaveSpawned) {
        this.endWaveSpawned = true;
        this.spawnWave([{ kind: 'runner', x: 50, y: 106 }, { kind: 'runner', x: 45, y: 92 }, { kind: 'stalker', x: 58, y: 106 }]);
      }
    } else {
      this.exitOpened = true;
      this.ui.onToast('IT KNOWS. RUN — DOWN.', true);
      if (!this.finalWaveSpawned) {
        this.finalWaveSpawned = true;
        this.spawnWave([{ kind: 'runner', x: 58, y: 33 }, { kind: 'runner', x: 63, y: 25 }, { kind: 'heavy', x: 59, y: 30 }]);
      }
    }
    this.updateObjective();
  }

  private onCrate(c: CrateDef) {
    void c;
    this.audio.crateOpen();
    this.cratesOpened++;
    const roll = Math.random();
    // blades and goggles turn up in crates — never endgame ammunition
    const unownedMelee = MELEE_IDS.filter((id) => !this.weapons.owned.has(id));
    const unownedGoggles = (['night', 'thermal'] as GoggleKind[]).filter((k) => !this.gogglesOwned.has(k));
    const meleeForced = this.cratesOpened >= 4 && !MELEE_IDS.some((id) => this.weapons.owned.has(id)) && unownedMelee.length > 0;
    if ((meleeForced || roll < 0.15) && unownedMelee.length) {
      const id = pick(unownedMelee);
      this.weapons.giveWeapon(id);
      this.ui.onToast(`CRATE: ${WEAPONS[id].name} — BLADE [B TO CYCLE · TAB FOR INVENTORY]`);
    } else if (roll < 0.24 && unownedGoggles.length) {
      this.grantGoggle(pick(unownedGoggles));
    } else if (roll < 0.55) {
      // ammunition for a gun you own (melee/endgame excluded)
      const ownedCommon = [...this.weapons.owned].filter((w) => {
        const k = AMMO_FOR_WEAPON[w];
        return k !== undefined && !RARE_AMMO.has(k);
      });
      if (ownedCommon.length) {
        const id = pick(ownedCommon);
        const kind = AMMO_FOR_WEAPON[id]!;
        this.weapons.addAmmo(kind, AMMO_PER_PICKUP[kind]);
        this.ui.onToast(`CRATE: ${WEAPONS[id].name} AMMO +${AMMO_PER_PICKUP[kind]}`);
      } else if (this.medkits < 4) {
        this.medkits++;
        this.ui.onToast('CRATE: MEDKIT +1 (Q TO USE)');
      } else {
        this.ui.onToast('CRATE: DUST AND GOOD INTENTIONS');
      }
    } else if (roll < 0.72) {
      if (this.medkits < 4) { this.medkits++; this.ui.onToast('CRATE: MEDKIT +1 (Q TO USE)'); }
      else this.ui.onToast('CRATE: MEDKIT (POUCH FULL)', true);
    } else if (roll < 0.82) {
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 18);
      this.ui.onToast('CRATE: STALE RATIONS (+18 HP)');
    } else {
      this.ui.onToast('CRATE: DUST, DEAD BATTERIES, A SINGLE CHILD\'S SHOE');
    }
    this.audio.pickup();
  }

  private updateObjective(force = false) {
    let text: string;
    if (this.finalOpened) text = 'ESCAPE — THROUGH THE FINAL EXIT, DO NOT STOP';
    else if (this.highestArea >= AREA_L4 || this.exitOpened) {
      if (!this.power2On) text = this.highestArea >= AREA_L4 ? 'RESTART GENERATOR G-3 — THE DUCTS CONNECT EVERYTHING' : 'DESCEND THE SERVICE SHAFT';
      else if (!this.pumpsOn) text = 'START THE DRAINAGE PUMPS — NORTH-EAST PLATFORM';
      else if (!this.hasGoldKey) text = 'FIND THE GOLD PASS IN THE OFFICE SECURITY ROOM';
      else if (!this.power3On) text = 'RESTART GENERATOR G-4 IN THE BLACKOUT ZONE';
      else if (!this.hasFuse) text = 'STEAL THE CORE FUSE FROM THE NEST';
      else text = this.highestArea >= AREA_L9 ? 'REACH THE EXPERIMENT\'S EXIT — FAR EAST' : 'BRING THE FUSE EAST — INTO THE EXPERIMENT';
    } else if (!this.hasKeycard && this.highestArea < 1) text = 'PUSH EAST — FIND THE SERVICE MAZE';
    else if (!this.hasKeycard) text = 'LOCATE THE SECURITY KEYCARD';
    else if (!this.powerOn) text = 'START GENERATOR G-2 — RESTORE POWER';
    else text = 'OPEN THE THRESHOLD DOOR — FAR EAST OF THE DARK ZONE';
    if (force || text !== this.lastObjective) {
      this.lastObjective = text;
      this.ui.onObjective(text);
    }
  }

  private writeSave() {
    const w = this.weapons.serialize();
    // cheat-granted weapons are never persisted: the save only holds what was found
    const owned = w.owned.filter((id) => !this.cheatGranted.has(id));
    const mags = { ...w.mags };
    const reserve = { ...w.reserve };
    for (const id of this.cheatGranted) { mags[id] = 0; reserve[id] = 0; }
    const save: SaveData = {
      version: 1,
      areaIndex: this.highestArea,
      health: Math.max(30, Math.round(this.player.health)),
      weapons: owned.length ? owned : ['pistol'],
      currentWeapon: owned.includes(w.current) ? w.current : 'pistol',
      mags, reserve,
      hasKeycard: this.hasKeycard,
      powerOn: this.powerOn,
      kills: this.stats.kills,
      playTime: Math.round(this.sessionTime),
      hasGoldKey: this.hasGoldKey,
      power2: this.power2On,
      power3: this.power3On,
      pumpsOn: this.pumpsOn,
      hasFuse: this.hasFuse,
      labOn: this.labOn,
      // cheat-granted goggles are never persisted either
      goggles: [...this.gogglesOwned].filter((k) => !this.cheatGoggles.has(k)),
      goggleEq: this.goggleEquipped && !this.cheatGoggles.has(this.goggleEquipped) ? this.goggleEquipped : null,
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ }
    this.saveFlashTimer = 1.6;
  }

  private monsterHear(m: VentMonster, pos: THREE.Vector3, radius: number, loud: boolean) {
    if (m instanceof Crawler) m.hearNoise(pos, radius, loud, this.audio);
    else m.hearNoise(pos, radius, loud);
  }

  private noiseEvent(pos: THREE.Vector3, radius: number, loud: boolean) {
    for (const e of this.enemies) e.hearNoise(pos, radius, loud);
    // room noise carries up into nearby ductwork, muffled
    for (const m of this.ventMonsters) this.monsterHear(m, pos, radius * 0.55, loud);
  }

  // ======================================================== secret cheat
  /** ` — grant every registered weapon + both goggles (from the registries). */
  private grantArsenal() {
    const newly = this.weapons.grantAll();
    for (const id of newly) this.cheatGranted.add(id);
    for (const kind of ['night', 'thermal'] as GoggleKind[]) {
      if (!this.gogglesOwned.has(kind)) {
        this.gogglesOwned.add(kind);
        this.cheatGoggles.add(kind);
      }
    }
    if (!this.goggleEquipped) this.goggleEquipped = 'night';
    this.applyGoggleVision();
    this.pushInventory();
    this.audio.keycard();
    this.ui.onToast('ARSENAL UNLOCKED — ALL WEAPONS + GOGGLES ACQUIRED');
  }

  // ======================================================== goggles
  private goggleMode(): 'none' | GoggleKind {
    return this.goggleOn && this.goggleEquipped ? this.goggleEquipped : 'none';
  }

  /** Apply (or clear) the night/thermal vision presentation. */
  private applyGoggleVision() {
    const mode = this.goggleMode();
    this.renderer.toneMappingExposure = mode === 'night' ? 1.62 : mode === 'thermal' ? 1.02 : 1.12;
    this.hemiLight.intensity = mode === 'night' ? 1.7 : mode === 'thermal' ? 0.16 : 0.62;
    this.ambLight.intensity = mode === 'night' ? 1.6 : mode === 'thermal' ? 0.1 : 0.7;
    this.hemiLight.color.setHex(mode === 'thermal' ? 0x2a2a66 : 0x9a8a5c);
    this.ambLight.color.setHex(mode === 'thermal' ? 0x1c1c44 : 0x2a2113);
    for (const s of this.heatSprites) s.visible = mode === 'thermal';
    if (mode !== 'none') this.moodAreaIdx = -1; // force fog re-apply under the override
  }

  private grantGoggle(kind: GoggleKind, silent = false) {
    if (this.gogglesOwned.has(kind)) return false;
    this.gogglesOwned.add(kind);
    if (!this.goggleEquipped) {
      this.goggleEquipped = kind;
      this.goggleOn = true;
      this.applyGoggleVision();
    }
    if (!silent) {
      this.audio.keycard();
      this.ui.onToast(kind === 'night' ? 'NIGHT VISION GOGGLES — PRESS N' : 'THERMAL GOGGLES — PRESS N');
    }
    this.pushInventory();
    return true;
  }

  private toggleGoggles() {
    if (!this.goggleEquipped) {
      this.ui.onToast('NO GOGGLES EQUIPPED — FIND SOME, OR OPEN INVENTORY [TAB]', true);
      return;
    }
    this.goggleOn = !this.goggleOn;
    this.applyGoggleVision();
    this.audio.uiClick();
    this.ui.onToast(this.goggleOn
      ? (this.goggleEquipped === 'night' ? 'NIGHT VISION ON' : 'THERMAL VISION ON')
      : 'GOGGLES OFF');
    this.pushInventory();
  }

  private equipGoggle(kind: GoggleKind | null) {
    if (kind && !this.gogglesOwned.has(kind)) return;
    this.goggleEquipped = kind;
    this.goggleOn = kind !== null;
    this.applyGoggleVision();
    this.audio.uiClick();
    this.pushInventory();
  }

  // ======================================================== inventory (TAB)
  private buildInventory(): InventorySnapshot {
    return {
      weapons: WEAPON_ORDER.filter((id) => this.weapons.owned.has(id)).map((id) => ({
        id,
        name: WEAPONS[id].name,
        slotLabel: WEAPONS[id].slot >= 12 ? 'B' : String(WEAPONS[id].slot === 10 ? 0 : WEAPONS[id].slot === 11 ? '-' : WEAPONS[id].slot),
        detail: WEAPONS[id].melee ? 'MELEE — NO AMMO' : `${this.weapons.mags[id]} / ${this.weapons.reserve[id]}`,
        current: this.weapons.current === id,
      })),
      goggles: (['night', 'thermal'] as GoggleKind[]).map((kind) => ({
        kind,
        owned: this.gogglesOwned.has(kind),
        equipped: this.goggleEquipped === kind,
      })),
      goggleOn: this.goggleOn,
      medkits: this.medkits,
      health: Math.round(this.player.health),
      hasKeycard: this.hasKeycard,
      hasGold: this.hasGoldKey,
      hasFuse: this.hasFuse,
    };
  }

  private pushInventory() {
    if (this.invOpen) this.ui.onInventory(this.buildInventory());
  }

  private openInventory() {
    if (this.invOpen || this.phase !== 'playing') return;
    this.invOpen = true;
    this.weapons.setTrigger(false);
    this.ui.onInventory(this.buildInventory());
    document.exitPointerLock(); // boundLockChange ignores this while invOpen
  }

  closeInventory() {
    if (!this.invOpen) return;
    this.invOpen = false;
    this.ui.onInventory(null);
    if (this.phase === 'playing') this.lockPointer();
  }

  inventorySelect(id: WeaponId) {
    this.weapons.select(id);
    this.pushInventory();
  }

  inventoryEquipGoggle(kind: GoggleKind | null) {
    this.equipGoggle(kind);
  }

  inventoryTogglePower() {
    this.toggleGoggles();
  }

  // ======================================================== combat
  private raySphere(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, r: number): number {
    const ox = center.x - origin.x;
    const oy = center.y - origin.y;
    const oz = center.z - origin.z;
    const tca = ox * dir.x + oy * dir.y + oz * dir.z;
    if (tca < 0) return -1;
    const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
    if (d2 > r * r) return -1;
    return tca - Math.sqrt(r * r - d2);
  }

  /** Everything currently shootable from where the player is. */
  private hitTargets(): HitTarget[] {
    const out: HitTarget[] = [];
    if (this.crawl) {
      // inside a duct you can only hit creatures in this same duct network
      for (const m of this.ventMonsters) {
        if (!m.alive || m.isDead || !m.inVent || m.net !== this.crawl.network) continue;
        const base = m.pos.y + (m instanceof VentStalker ? 0.25 : 0);
        out.push({ t: m, baseY: base, height: m.heightTotal, headY: base + m.eyeHeight, headR: 0.18, bodyR: m.radius + 0.12 });
      }
      return out;
    }
    for (const e of this.enemies) {
      if (!e.alive || e.isDead) continue;
      out.push({
        t: e, baseY: 0, height: ENEMY_HEIGHT[e.kind] ?? 2.2,
        headY: e.stats.eyeHeight + 0.14, headR: e.kind === 'heavy' || e.kind === 'guardian' ? 0.28 : 0.25,
        bodyR: e.stats.radius + 0.17,
      });
    }
    for (const m of this.ventMonsters) {
      if (!m.alive || m.isDead || m.inVent) continue; // a Crawler that has dropped into the room
      out.push({ t: m, baseY: 0, height: m.heightTotal, headY: m.eyeHeight, headR: 0.2, bodyR: m.radius + 0.14 });
    }
    return out;
  }

  private fireRay(origin: THREE.Vector3, dir: THREE.Vector3, range: number): FireResult {
    let bestT: number;
    let nx = 0, nz = 0;
    if (this.crawl) {
      // a duct is a closed metal tube: rounds stop within a few metres
      bestT = Math.min(range, 9);
    } else {
      const wall = this.world.raycast(origin, dir, range);
      bestT = wall.hit ? wall.dist : range;
      nx = wall.nx; nz = wall.nz;
      // floor / ceiling stop rounds too
      if (dir.y < -0.001) bestT = Math.min(bestT, (origin.y - 0.02) / -dir.y);
      if (dir.y > 0.001) bestT = Math.min(bestT, (WALL_H - origin.y) / dir.y);
    }
    let target: DamageTarget | null = null;
    let part: 'head' | 'body' | null = null;
    for (const h of this.hitTargets()) {
      const p = h.t.pos;
      const tHead = this.raySphere(origin, dir, new THREE.Vector3(p.x, h.headY, p.z), h.headR);
      const tBody1 = this.raySphere(origin, dir, new THREE.Vector3(p.x, h.baseY + h.height * 0.34, p.z), h.bodyR);
      const tBody2 = this.raySphere(origin, dir, new THREE.Vector3(p.x, h.baseY + h.height * 0.66, p.z), h.bodyR * 0.96);
      let t = -1;
      let pp: 'head' | 'body' = 'body';
      if (tBody1 > 0) t = tBody1;
      if (tBody2 > 0 && (t < 0 || tBody2 < t)) t = tBody2;
      if (tHead > 0 && (t < 0 || tHead < t + 0.35)) { t = tHead; pp = 'head'; }
      if (t > 0 && t < bestT) { bestT = t; target = h.t; part = pp; }
    }
    const point = origin.clone().addScaledVector(dir, bestT);
    return { dist: bestT, point, nx, nz, target, part };
  }

  private markHit(kill: boolean) {
    this.stats.shotsHit++;
    this.hitmarkTimer = kill ? 0.32 : 0.16;
    this.hitmarkKill = kill;
  }

  private damagePlayer(amount: number, fromPos: THREE.Vector3) {
    if (this.phase !== 'playing' || this.player.health <= 0) return;
    this.player.health -= amount;
    this.damageFlash = Math.min(1, this.damageFlash + 0.55);
    this.trauma = Math.min(1, this.trauma + 0.3);
    this.audio.hurt();
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const me = this.crawl ? footholdPos(this.crawl, new THREE.Vector3()) : this.player.pos;
    const toAtk = fromPos.clone().sub(me).setY(0).normalize();
    this.damageDirAngle = Math.atan2(fwd.x * toAtk.z - fwd.z * toAtk.x, fwd.x * toAtk.x + fwd.z * toAtk.z);
    this.damageDirTimer = 1.1;
    if (this.player.health <= 0) {
      this.player.health = 0;
      this.die();
    }
  }

  private die() {
    this.audio.stinger(0.8);
    if (this.alarmStop) { this.alarmStop(); this.alarmStop = null; }
    this.audio.stopFanHum();
    this.setPhase('dead');
    document.exitPointerLock();
  }

  private victory() {
    if (this.alarmStop) { this.alarmStop(); this.alarmStop = null; }
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    this.audio.stinger(0.4);
    this.setPhase('victory');
    document.exitPointerLock();
  }

  // ======================================================== projectiles
  private launchProjectile(kind: ProjectileKind, origin: THREE.Vector3, dir: THREE.Vector3) {
    const speed = kind === 'bazooka' ? 26 : kind === 'rocket' ? 34 : 17;
    // the muzzle sits ~0.9 m ahead of the eye: if that pokes through a wall,
    // launch from just in front of the face instead so it can't tunnel through
    if (!this.world.lineOfSight(this.camera.position, origin)) {
      origin = this.camera.position.clone().addScaledVector(dir, 0.35);
    }
    const mesh = this.protoMesh[kind].clone();
    mesh.position.copy(origin);
    mesh.lookAt(origin.clone().sub(dir)); // models point down -Z
    this.scene.add(mesh);
    this.projectiles.push({
      kind, pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), mesh, life: 6,
      target: kind === 'rocket' ? this.lockedTarget : null, trail: 0,
    });
    if (kind !== 'antimatter') {
      // back-blast smoke
      this.effects.burst(origin.clone().addScaledVector(dir, -0.8), { count: 10, color: [0x5a544a, 0x3a3630], speed: 1.6, life: 0.9, size: 14, gravity: -0.4 });
    }
    if (kind === 'rocket' && this.lockedTarget) this.lockedTarget = null; // one missile per lock
  }

  private updateProjectiles(dt: number) {
    const targets = this.hitTargets();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      // guidance
      if (pr.kind === 'rocket' && pr.target && pr.target.alive && !pr.target.isDead) {
        const aim = pr.target.pos.clone().setY(1.2).sub(pr.pos).normalize();
        const cur = pr.vel.clone().normalize();
        const ang = cur.angleTo(aim);
        if (ang > 0.001) cur.lerp(aim, Math.min(1, (2.8 * dt) / ang)).normalize();
        pr.vel.copy(cur.multiplyScalar(34));
      } else if (pr.kind === 'bazooka') {
        pr.vel.y -= 2.2 * dt; // heavy warhead droops
      }
      const step = pr.vel.clone().multiplyScalar(dt);
      const stepLen = step.length();
      const dir = step.clone().normalize();
      let hitDist = Infinity;
      const wall = this.world.raycast(pr.pos, dir, stepLen + 0.1);
      if (wall.hit) hitDist = wall.dist;
      const next = pr.pos.clone().add(step);
      if (next.y < 0.05) hitDist = Math.min(hitDist, (pr.pos.y - 0.05) / Math.max(0.001, -dir.y));
      if (next.y > WALL_H - 0.05) hitDist = Math.min(hitDist, (WALL_H - 0.05 - pr.pos.y) / Math.max(0.001, dir.y));
      // entities: closest approach along this step
      for (const h of targets) {
        const c = new THREE.Vector3(h.t.pos.x, h.baseY + h.height * 0.5, h.t.pos.z);
        const tt = clamp(c.clone().sub(pr.pos).dot(dir), 0, stepLen);
        const closest = pr.pos.clone().addScaledVector(dir, tt);
        if (closest.distanceTo(c) < h.bodyR + h.height * 0.25) hitDist = Math.min(hitDist, tt);
      }
      if (hitDist <= stepLen || pr.life <= 0) {
        const impact = pr.pos.clone().addScaledVector(dir, Math.max(0, Math.min(hitDist, stepLen) - 0.25));
        this.scene.remove(pr.mesh);
        this.projectiles.splice(i, 1);
        if (pr.kind === 'antimatter') this.spawnAnomaly(impact);
        else this.explode(impact, pr.kind === 'bazooka' ? 6 : 4.6, WEAPONS[pr.kind].damage, pr.kind === 'bazooka' ? 1.25 : 0.95);
        continue;
      }
      pr.pos.copy(next);
      pr.mesh.position.copy(next);
      pr.mesh.lookAt(next.clone().sub(dir));
      // trails
      pr.trail -= dt;
      if (pr.trail <= 0) {
        pr.trail = 0.018;
        if (pr.kind === 'antimatter') {
          this.effects.emit(pr.pos, new THREE.Vector3(rand(-0.4, 0.4), rand(-0.4, 0.4), rand(-0.4, 0.4)), Math.random() < 0.5 ? 0x9a6cff : 0xffffff, 0.35, 6, 0);
        } else {
          this.effects.emit(pr.pos.clone().addScaledVector(dir, -0.3), new THREE.Vector3(rand(-0.25, 0.25), rand(0.1, 0.5), rand(-0.25, 0.25)), Math.random() < 0.5 ? 0x6a645a : 0x8a8478, 1.1, 12, -0.25);
          this.effects.emit(pr.pos.clone().addScaledVector(dir, -0.2), new THREE.Vector3(0, 0, 0), 0xffb35a, 0.08, 7, 0);
        }
      }
    }
  }

  /** Area damage with linear falloff; walls block it (line-of-sight test). */
  private explode(pos: THREE.Vector3, radius: number, damage: number, size: number) {
    this.effects.explosion(pos, size);
    this.audio.explosion(pos, size);
    this.noiseEvent(pos, 55, true);
    const losFrom = pos.clone();
    losFrom.y = clamp(losFrom.y, 0.6, WALL_H - 0.4);
    for (const h of this.hitTargets()) {
      if (this.crawl) break; // no room targets while crawling
      const c = new THREE.Vector3(h.t.pos.x, h.baseY + h.height * 0.5, h.t.pos.z);
      const d = c.distanceTo(pos);
      if (d > radius + h.bodyR) continue;
      if (!this.world.lineOfSight(losFrom, c)) continue;
      const dmg = damage * lerp(1, 0.25, clamp(d / radius, 0, 1));
      const killed = h.t.applyDamage(dmg, 'body', c, c.clone().sub(pos).normalize());
      this.markHit(killed);
    }
    const me = this.camera.position;
    const pd = me.distanceTo(pos);
    if (!this.crawl && pd < radius && this.world.lineOfSight(losFrom, me)) {
      this.damagePlayer(damage * 0.26 * (1 - pd / radius), pos);
    }
    this.trauma = Math.min(1, this.trauma + clamp(1.1 - pd / 22, 0, 0.8));
  }

  // ======================================================== anti-matter
  private spawnAnomaly(pos: THREE.Vector3) {
    const p = pos.clone();
    p.y = clamp(p.y, 1.0, WALL_H - 1.0);
    const g = new THREE.Group();
    g.position.copy(p);
    const core = new THREE.Mesh(this.anomalyCoreGeo, this.anomalyCoreMat);
    const rim = new THREE.Mesh(this.anomalyRimGeo, this.anomalyRimMat);
    const halo = new THREE.Mesh(this.anomalyHaloGeo, this.anomalyHaloMat);
    g.add(core, rim, halo);
    g.scale.setScalar(0.01);
    this.scene.add(g);
    this.anomalies.push({ pos: p, age: 0, life: 4.2, radius: 9, mesh: g });
    this.audio.anomalyOpen(p);
    this.effects.shockwave(p, 3);
  }

  private updateAnomalies(dt: number) {
    let lightOn = false;
    for (let i = this.anomalies.length - 1; i >= 0; i--) {
      const a = this.anomalies[i];
      a.age += dt;
      const grow = clamp(a.age / 0.45, 0, 1);
      const collapse = clamp((a.life - a.age) / 0.35, 0, 1);
      const s = grow * collapse * (0.75 + Math.sin(a.age * 14) * 0.05);
      a.mesh.scale.setScalar(Math.max(0.01, s));
      const rim = a.mesh.children[1];
      rim.lookAt(this.camera.position);
      a.mesh.children[2].scale.setScalar(2.6 + Math.sin(a.age * 6) * 0.2);
      // inward spiral of particles: the visible "distortion"
      const n = Math.round(7 * this.effects.quality);
      for (let k = 0; k < n; k++) {
        const th = rand(0, Math.PI * 2);
        const ph = Math.acos(rand(-1, 1));
        const r = rand(2.2, a.radius * 0.6);
        const off = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.5, Math.sin(ph) * Math.sin(th)).multiplyScalar(r);
        const start = a.pos.clone().add(off);
        if (start.y < 0.1 || start.y > WALL_H - 0.1) continue;
        const inward = off.clone().multiplyScalar(-1 / 0.55);
        const tangent = new THREE.Vector3(-off.z, 0, off.x).normalize().multiplyScalar(r * 1.4);
        this.effects.emit(start, inward.add(tangent), Math.random() < 0.65 ? 0x8a5cff : 0xe8deff, 0.55, rand(3, 7), 0);
      }
      // the pull: capped speed, walls respected (collide), bosses resist
      const losFrom = a.pos;
      for (const e of this.enemies) {
        if (!e.alive || e.isDead) continue;
        const c = e.pos.clone().setY(1.2);
        const d = c.distanceTo(a.pos);
        if (d > a.radius || !this.world.lineOfSight(losFrom, c)) continue;
        e.pullToward(a.pos, 2.5 + 5 * (1 - d / a.radius), dt, this.world);
        e.applyDamage(14 * dt * (1 - e.anomalyResist), 'body', c, a.pos.clone().sub(c).normalize());
      }
      for (const m of this.ventMonsters) {
        if (!m.alive || m.isDead || m.inVent) continue;
        const d = m.pos.distanceTo(a.pos);
        if (d > a.radius || !this.world.lineOfSight(losFrom, m.pos.clone().setY(0.6))) continue;
        const to = a.pos.clone().sub(m.pos).setY(0);
        m.pos.addScaledVector(to.normalize(), Math.min(to.length(), 5 * dt));
        this.world.collide(m.pos, m.radius, true);
      }
      // the player feels it too — a gentle, capped tug
      if (!this.crawl) {
        const d = this.camera.position.distanceTo(a.pos);
        if (d < a.radius * 0.7 && this.world.lineOfSight(losFrom, this.camera.position)) {
          const to = a.pos.clone().sub(this.player.pos).setY(0);
          this.player.pos.addScaledVector(to.normalize(), Math.min(to.length(), 1.6 * dt));
          this.world.collide(this.player.pos, this.player.radius, false);
        }
      }
      lightOn = true;
      this.anomalyLight.position.copy(a.pos);
      this.anomalyLight.intensity = 30 * s;
      if (a.age >= a.life) {
        // implosion
        this.audio.anomalyCollapse(a.pos);
        this.effects.burst(a.pos, { count: 50, color: [0x9a6cff, 0xffffff, 0x2a1a5a], speed: 9, life: 0.7, size: 10, gravity: 0 });
        this.effects.shockwave(a.pos, 7);
        this.trauma = Math.min(1, this.trauma + clamp(1 - this.camera.position.distanceTo(a.pos) / 20, 0, 0.7));
        const killR = 5.5;
        for (const h of this.hitTargets()) {
          if (this.crawl) break;
          const c = new THREE.Vector3(h.t.pos.x, h.baseY + h.height * 0.5, h.t.pos.z);
          const d = c.distanceTo(a.pos);
          if (d > killR || !this.world.lineOfSight(losFrom, c)) continue;
          const resist = h.t instanceof Enemy ? h.t.anomalyResist : 0;
          const killed = h.t.applyDamage(WEAPONS.antimatter.damage * (1 - resist), 'body', c, a.pos.clone().sub(c).normalize());
          this.markHit(killed);
        }
        const pd = this.camera.position.distanceTo(a.pos);
        if (!this.crawl && pd < 3.5) this.damagePlayer(35 * (1 - pd / 3.5), a.pos);
        this.noiseEvent(a.pos, 50, true);
        this.scene.remove(a.mesh);
        this.anomalies.splice(i, 1);
      }
    }
    if (!lightOn) this.anomalyLight.intensity = 0;
  }

  // ======================================================== rocket lock
  private updateLock(dt: number, eye: THREE.Vector3) {
    const seeking = this.weapons.current === 'rocket' && this.weapons.adsAmount > 0.6 && !this.crawl && !this.weapons.reloading;
    if (!seeking) {
      this.lockCandidate = null;
      this.lockTime = 0;
      if (this.weapons.current !== 'rocket') this.lockedTarget = null;
      this.weapons.lockState = this.lockedTarget ? 'locked' : 'none';
      return;
    }
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    let best: Enemy | null = null;
    let bestDot = 0.965;
    for (const e of this.enemies) {
      if (!e.alive || e.isDead) continue;
      const c = e.pos.clone().setY(1.2);
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > 75) continue;
      const dot = fwd.dot(to.normalize());
      // never acquire through walls
      if (dot > bestDot && this.world.lineOfSight(eye, c)) { bestDot = dot; best = e; }
    }
    if (best) {
      this.lockLost = 0;
      if (best === this.lockCandidate) {
        const before = this.lockTime;
        this.lockTime += dt;
        if (Math.floor(before * 6) !== Math.floor(this.lockTime * 6) && this.lockTime < 0.9) this.audio.lockTone(false);
        if (before < 0.9 && this.lockTime >= 0.9) {
          this.lockedTarget = best;
          this.audio.lockTone(true);
        }
      } else {
        this.lockCandidate = best;
        this.lockTime = 0;
      }
    } else {
      this.lockLost += dt;
      if (this.lockLost > 0.5) {
        this.lockCandidate = null;
        this.lockTime = 0;
        this.lockedTarget = null;
      }
    }
    if (this.lockedTarget && (!this.lockedTarget.alive || this.lockedTarget.isDead)) this.lockedTarget = null;
    this.weapons.lockState = this.lockedTarget ? 'locked' : this.lockCandidate ? 'seeking' : 'none';
  }

  // ======================================================== vents
  private enterCrawl(portal: VentPortal) {
    const net = portal.network;
    const node = portal.nodeId;
    const next = net.adjacency[node][0];
    if (next === undefined) return;
    this.crawl = { network: net, a: node, b: next, t: 0, bob: 0, moving: false, fast: false, stepAcc: 0 };
    this.camFrom.copy(this.camera.position);
    this.camTransition = 0.45;
    this.player.vel.set(0, 0, 0);
    this.player.pitch = clamp(this.player.pitch, -0.6, 0.6);
    this.adsHeld = false;
    this.audio.startFanHum();
    this.audio.doorMove(true, portal.roomPos.clone().setY(2.4), false);
    for (const m of this.ventMonsters) this.monsterHear(m, portal.roomPos.clone().setY(2.4), 12, false);
    if (!this.ventHintShown) {
      this.ventHintShown = true;
      this.ui.onToast('IN THE DUCTS — W/S CRAWL · SHIFT = FAST & LOUD · E AT A GRATE TO DROP · G TO SHUT IT');
    }
  }

  /** Leave the ducts through `portal` (or forcibly reset with force=true). */
  private exitCrawl(portal: VentPortal | null, force = false) {
    if (!this.crawl) return;
    this.crawl = null;
    this.audio.stopFanHum();
    if (force || !portal) return;
    this.camFrom.copy(this.camera.position);
    this.camTransition = 0.45;
    this.player.pos.copy(portal.roomPos);
    this.player.vel.set(0, 0, 0);
    this.world.collide(this.player.pos, this.player.radius, false);
    this.audio.jumpLand();
    this.noiseEvent(this.player.pos, 9, false);
  }

  private crawlPortalHere(): VentPortal | null {
    if (!this.crawl) return null;
    const c = this.crawl;
    const node = c.t < 0.2 ? c.a : c.t > 0.8 ? c.b : -1;
    return node < 0 ? null : this.vents.portalAt(c.network, node);
  }

  private updateCrawl(dt: number) {
    const c = this.crawl!;
    const net = c.network;
    const p = this.player;
    const fwdInput = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0);
    c.fast = this.input.sprint && fwdInput !== 0 && !p.exhausted && p.stamina > 1;
    const speed = c.fast ? 2.9 : 2.0;
    if (c.fast) {
      p.stamina = Math.max(0, p.stamina - 24 * dt);
      if (p.stamina <= 0) p.exhausted = true;
    } else {
      p.stamina = Math.min(p.maxStamina, p.stamina + 12 * dt);
      if (p.exhausted && p.stamina > 26) p.exhausted = false;
    }
    const desired = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)).multiplyScalar(fwdInput);
    c.moving = false;
    if (fwdInput !== 0) {
      const pa = net.nodes[c.a].pos, pb = net.nodes[c.b].pos;
      const segDir = pb.clone().sub(pa).setY(0);
      const len = segDir.length();
      segDir.normalize();
      const along = desired.dot(segDir);
      if (Math.abs(along) > 0.2) {
        c.t += (Math.sign(along) * speed * dt) / Math.max(0.01, len);
        c.moving = true;
      }
      // at a junction: steer into whichever branch the camera faces
      const pickBranch = (node: number, exclude: number): number => {
        let best = -1;
        let bestDot = 0.35;
        for (const n of net.adjacency[node]) {
          if (n === exclude) continue;
          const d = net.nodes[n].pos.clone().sub(net.nodes[node].pos).setY(0).normalize();
          const dd = desired.dot(d);
          if (dd > bestDot) { bestDot = dd; best = n; }
        }
        return best;
      };
      if (c.t >= 1) {
        const n = pickBranch(c.b, c.a);
        if (n >= 0) { c.a = c.b; c.b = n; c.t = 0; }
        else c.t = 1;
      } else if (c.t <= 0) {
        const n = pickBranch(c.a, c.b);
        if (n >= 0) { c.b = c.a; c.a = n; c.t = 1; }
        else c.t = 0;
      } else if (!c.moving) {
        // standing mid-segment facing sideways: nothing to do
      }
    }
    const fp = footholdPos(c, new THREE.Vector3());
    p.pos.set(fp.x, 0, fp.z);
    p.speed2D = c.moving ? speed : 0;
    if (c.moving) {
      c.bob += dt * (c.fast ? 9 : 6.5);
      c.stepAcc += speed * dt;
      if (c.stepAcc > (c.fast ? 0.7 : 0.9)) {
        c.stepAcc = 0;
        this.audio.footstep(c.fast, true);
      }
    }
    // the ducts groan around you
    this.crawlCreakTimer -= dt;
    if (this.crawlCreakTimer <= 0) {
      this.crawlCreakTimer = rand(3, 8);
      this.audio.ventCreak(fp.clone().add(new THREE.Vector3(rand(-6, 6), 0.4, rand(-6, 6))));
    }
    // interaction: grates at junctions
    const portal = this.crawlPortalHere();
    if (portal) {
      this.interactTarget = portal.grateOpen
        ? { label: 'DROP DOWN THROUGH THE GRATE', act: () => this.exitCrawl(portal) }
        : { label: 'PUSH THE GRATE OPEN', act: () => { portal.grateOpen = true; this.audio.doorMove(true, portal.roomPos.clone().setY(2.3), false); } };
    } else {
      this.interactTarget = null;
    }
  }

  private toggleNearestGrate() {
    const portal = this.crawl ? this.crawlPortalHere() : this.vents.portalNear(this.player.pos, 2.4);
    if (!portal) return;
    portal.grateOpen = !portal.grateOpen;
    this.audio.doorMove(portal.grateOpen, portal.roomPos.clone().setY(2.3), false);
    this.ui.onToast(portal.grateOpen ? 'GRATE OPEN' : 'GRATE SHUT — IT WILL SLOW A CRAWLER. BRIEFLY.');
  }

  // ======================================================== hazards
  private updateHazard(dt: number) {
    if (this.currentAreaIdx !== AREA_L5 || this.crawl) {
      this.world.setHazardGlow(false);
      return;
    }
    this.hazardTimer -= dt;
    if (this.hazardTimer < 1.3) {
      // clearly telegraphed: the cabinet sputters and buzzes before it arcs
      if (!this.hazardCharging) {
        this.hazardCharging = true;
        this.audio.zap(this.world.hazardPos);
      }
      this.world.setHazardGlow(Math.random() < 0.5);
      if (Math.random() < dt * 8) this.effects.burst(this.world.hazardPos.clone().setY(1.3), { count: 3, color: 0xbfe2ff, speed: 2, life: 0.2, size: 3, gravity: 4 });
    }
    if (this.hazardTimer <= 0) {
      this.hazardTimer = rand(5, 8);
      this.hazardCharging = false;
      this.world.setHazardGlow(true);
      this.scheduleForRun(() => this.world.setHazardGlow(false), 160);
      const hp = this.world.hazardPos;
      this.audio.zap(hp);
      this.effects.burst(hp.clone().setY(0.3), { count: 26, color: [0xbfe2ff, 0xffffff, 0x6ab0ff], speed: 6, life: 0.35, size: 5, gravity: 0 });
      this.trauma = Math.min(1, this.trauma + 0.1);
      const reach = this.pumpsOn ? 3.5 : 8.5;
      const d = Math.hypot(this.player.pos.x - hp.x, this.player.pos.z - hp.z);
      if (this.world.waterAt(this.player.pos) > 0 && d < reach) this.damagePlayer(20, hp);
      for (const e of this.enemies) {
        if (!e.alive || e.isDead) continue;
        if (this.world.waterAt(e.pos) > 0 && Math.hypot(e.pos.x - hp.x, e.pos.z - hp.z) < reach) {
          e.applyDamage(30, 'body', e.pos.clone().setY(1), new THREE.Vector3(0, 1, 0));
        }
      }
    }
  }

  // ======================================================== events
  private boundResize = () => this.resize();
  private boundKeyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private boundKeyUp = (e: KeyboardEvent) => this.onKey(e, false);
  private boundMouseMove = (e: MouseEvent) => {
    if (this.phase !== 'playing' || document.pointerLockElement !== this.renderer.domElement) return;
    const zoomScale = 1 - this.weapons.adsAmount * (this.weapons.def.scoped ? 0.82 : 0.3);
    const s = 0.00205 * this.settings.sensitivity * zoomScale;
    this.player.yaw -= e.movementX * s;
    this.player.pitch -= e.movementY * s * (this.settings.invertY ? -1 : 1);
    const lim = this.crawl ? 0.6 : 1.45; // the duct roof limits how far you can look
    this.player.pitch = clamp(this.player.pitch, -lim, lim);
  };
  private boundMouseDown = (e: MouseEvent) => {
    if (this.phase !== 'playing') return;
    if (document.pointerLockElement !== this.renderer.domElement) {
      this.lockPointer();
      return;
    }
    if (e.button === 0) this.weapons.setTrigger(true);
    if (e.button === 2) this.adsHeld = true;
  };
  private boundMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.weapons.setTrigger(false);
    if (e.button === 2) this.adsHeld = false;
  };
  private boundWheel = (e: WheelEvent) => {
    if (this.phase !== 'playing') return;
    const owned = WEAPON_ORDER.filter((w) => this.weapons.owned.has(w));
    if (owned.length < 2) return;
    const idx = owned.indexOf(this.weapons.current);
    const next = owned[(idx + (e.deltaY > 0 ? 1 : owned.length - 1)) % owned.length];
    this.weapons.select(next);
  };
  private boundLockChange = () => {
    // opening the inventory releases the pointer on purpose — don't pause for it
    if (document.pointerLockElement !== this.renderer.domElement && this.phase === 'playing' && !this.invOpen) {
      this.setPhase('paused');
    }
  };
  private boundCtx = (e: Event) => e.preventDefault();

  private bindEvents() {
    window.addEventListener('resize', this.boundResize);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('mousedown', this.boundMouseDown);
    window.addEventListener('mouseup', this.boundMouseUp);
    window.addEventListener('wheel', this.boundWheel);
    document.addEventListener('pointerlockchange', this.boundLockChange);
    this.renderer.domElement.addEventListener('contextmenu', this.boundCtx);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    // never treat typing in a text field as game input (cheat included)
    const el = (e.target as HTMLElement | null) ?? document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const c = e.code;
    if (down) {
      if (['Space', 'Tab', 'Backquote'].includes(c)) e.preventDefault();
      if (this.keys.has(c)) return;
      this.keys.add(c);
    } else {
      this.keys.delete(c);
    }
    switch (c) {
      case 'KeyW': case 'ArrowUp': this.input.forward = down; break;
      case 'KeyS': case 'ArrowDown': this.input.back = down; break;
      case 'KeyA': case 'ArrowLeft': this.input.left = down; break;
      case 'KeyD': case 'ArrowRight': this.input.right = down; break;
      case 'ShiftLeft': case 'ShiftRight': this.input.sprint = down; break;
      case 'ControlLeft': case 'KeyC': this.input.crouch = down; break;
      case 'Space': this.input.jump = down; break;
    }
    if (!down || this.phase !== 'playing') return;
    if (c === 'Backquote') { this.grantArsenal(); return; }
    if (c === 'Tab') {
      if (this.invOpen) this.closeInventory();
      else this.openInventory();
      return;
    }
    if (this.invOpen) return; // the panel has the keyboard while it's open
    if (c === 'KeyN') { this.toggleGoggles(); return; }
    if (c === 'KeyB') {
      // cycle owned blades
      const owned = MELEE_IDS.filter((id) => this.weapons.owned.has(id));
      if (owned.length) {
        const idx = owned.indexOf(this.weapons.current);
        this.weapons.select(owned[(idx + 1) % owned.length]);
      } else {
        this.ui.onToast('NO BLADE — CHECK CRATES', true);
      }
      return;
    }
    if (c === 'KeyE') {
      if (this.noteOpen) this.closeNote();
      else if (this.interactTarget) this.interactTarget.act();
    }
    if (c === 'KeyG') this.toggleNearestGrate();
    if (c === 'KeyR') this.weapons.startReload();
    // slot keys: 1-9, 0 (slot 10), - (slot 11) — resolved through the registry
    let slot = 0;
    if (/^Digit[1-9]$/.test(c)) slot = Number(c.slice(5));
    else if (c === 'Digit0') slot = 10;
    else if (c === 'Minus') slot = 11;
    if (slot) {
      const id = WEAPON_ORDER.find((w) => WEAPONS[w].slot === slot);
      if (id) this.weapons.select(id);
    }
    if (c === 'KeyF') {
      this.flashOn = !this.flashOn;
      this.audio.uiClick();
    }
    if (c === 'KeyQ') this.useMedkit();
    if (c === 'KeyP') this.pauseGame();
  }

  private useMedkit() {
    if (this.medkits <= 0) { this.ui.onToast('NO MEDKITS', true); return; }
    if (this.player.health >= this.player.maxHealth) { this.ui.onToast('HEALTH FULL'); return; }
    if (this.healTimer > 0) return;
    this.medkits--;
    this.healTimer = 0.9;
    this.healPool += 45;
    this.audio.heal();
  }

  private resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ======================================================== HUD (DOM)
  private el(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  private setText(id: string, text: string) {
    if (this.hudCache.get(id) === text) return;
    this.hudCache.set(id, text);
    const el = this.el(id);
    if (el) el.textContent = text;
  }

  private setOpacity(id: string, v: string) {
    const el = this.el(id);
    if (el && el.style.opacity !== v) el.style.opacity = v;
  }

  private updateHud() {
    const p = this.player;
    const healthEl = this.el('hud-health-fill');
    if (healthEl) {
      healthEl.style.width = `${clamp(p.health, 0, 100)}%`;
      healthEl.style.background = p.health < 30 ? '#c22e2e' : p.health < 60 ? '#c98a2e' : '#b8b04a';
    }
    const stamEl = this.el('hud-stamina-fill');
    if (stamEl) {
      stamEl.style.width = `${clamp(p.stamina, 0, 100)}%`;
      stamEl.style.opacity = p.exhausted ? '0.45' : '0.9';
    }
    if (this.weapons.def.melee) {
      this.setText('hud-ammo-mag', '—');
      this.setText('hud-ammo-reserve', 'MELEE');
    } else {
      this.setText('hud-ammo-mag', String(this.weapons.mags[this.weapons.current]));
      this.setText('hud-ammo-reserve', `/ ${this.weapons.reserve[this.weapons.current]}`);
    }
    this.setText('hud-weapon-name', this.weapons.def.name);
    this.setText('hud-medkits', `MEDKIT ×${this.medkits} [Q]`);
    this.setOpacity('hud-keycard', this.hasKeycard ? '1' : '0.22');
    this.setOpacity('hud-power', this.powerOn ? '1' : '0.22');
    this.setOpacity('hud-gold', this.hasGoldKey ? '1' : '0.22');
    this.setOpacity('hud-fuse', this.hasFuse ? '1' : '0.22');
    this.setOpacity('hud-flashlight', this.flashOn ? '1' : '0.3');
    for (const id of WEAPON_ORDER) {
      const slot = this.el(`hud-slot-${id}`);
      if (!slot) continue;
      const cls = `hud-slot ${this.weapons.owned.has(id) ? 'owned' : ''} ${this.weapons.current === id ? 'active' : ''}`;
      if (this.hudCache.get(`slot-${id}`) !== cls) {
        this.hudCache.set(`slot-${id}`, cls);
        slot.className = cls;
      }
    }
    const cross = this.el('hud-cross');
    if (cross) {
      const spread = 7 + this.player.speed2D * 1.6 + this.weapons.spreadBloom * 13 - this.weapons.adsAmount * 5;
      cross.style.setProperty('--sp', `${clamp(spread, 3, 30)}px`);
      cross.style.opacity = this.weapons.scoped ? '0' : this.weapons.adsAmount > 0.75 ? '0.25' : '0.9';
    }
    this.setOpacity('hud-scope', this.weapons.scoped ? '1' : '0');
    // goggles: HUD chip + fullscreen vision overlays
    const gm = this.goggleMode();
    this.setText('hud-goggle', gm === 'night' ? '[NV ON · N]' : gm === 'thermal' ? '[THERMAL ON · N]' : this.goggleEquipped ? '[GOGGLES OFF · N]' : '');
    this.setOpacity('hud-goggle', this.goggleEquipped ? '1' : '0.25');
    this.setOpacity('fx-night', gm === 'night' ? '1' : '0');
    this.setOpacity('fx-thermal', gm === 'thermal' ? '1' : '0');
    // HL-4 seeker readout
    const ls = this.weapons.current === 'rocket' ? this.weapons.lockState : 'none';
    this.setOpacity('hud-lock', ls === 'none' ? '0' : '1');
    this.setText('hud-lock', ls === 'locked' ? '[ TARGET LOCKED ]' : ls === 'seeking' ? '[ ACQUIRING… ]' : '');
    const lockEl = this.el('hud-lock');
    if (lockEl) lockEl.style.color = ls === 'locked' ? '#4dff7a' : '#ffb84d';
    // anti-matter charge readout
    this.setOpacity('hud-charge', this.weapons.chargeTimer > 0 ? '1' : '0');
    const hit = this.el('hud-hit');
    if (hit) {
      hit.style.opacity = this.hitmarkTimer > 0 ? '1' : '0';
      hit.style.color = this.hitmarkKill ? '#ff3b30' : '#e8e2cc';
    }
    this.setOpacity('hud-reloading', this.weapons.reloading ? '1' : '0');
    const vig = this.el('hud-vignette');
    if (vig) {
      const lowHp = p.health < 35 ? (0.25 + 0.18 * Math.sin(performance.now() * 0.006)) * (1 - p.health / 35) : 0;
      vig.style.opacity = String(clamp(this.damageFlash + lowHp, 0, 0.92));
    }
    const dd = this.el('hud-dmg-dir');
    if (dd) {
      dd.style.opacity = this.damageDirTimer > 0 ? String(clamp(this.damageDirTimer, 0, 0.9)) : '0';
      dd.style.transform = `translate(-50%,-50%) rotate(${this.damageDirAngle}rad)`;
    }
    const prompt = this.el('hud-prompt');
    if (prompt) {
      if (this.interactTarget && this.phase === 'playing' && !this.noteOpen && !this.invOpen) {
        prompt.style.opacity = '1';
        this.setText('hud-prompt-text', this.interactTarget.label);
      } else {
        prompt.style.opacity = '0';
      }
    }
    this.setOpacity('hud-saved', this.saveFlashTimer > 0 ? '0.8' : '0');
  }

  // ======================================================== main loop
  private setMenuCamera(t: number) {
    const a = new THREE.Vector3(14, 1.9, 50);
    const b = new THREE.Vector3(55, 2.1, 26);
    const k = (Math.sin(t * 0.05) + 1) / 2;
    this.camera.position.lerpVectors(a, b, k);
    this.camera.lookAt(40 + Math.sin(t * 0.11) * 18, 1.6, 34 + Math.cos(t * 0.07) * 14);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const camPos = this.camera.position;
    try {
      if (this.phase === 'menu') {
        this.menuTime += dt;
        this.setMenuCamera(this.menuTime);
        this.world.update(dt, camPos);
        this.effects.update(dt, camPos);
        this.audio.updateListener(this.camera);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      if (this.phase === 'playing') {
        this.sessionTime += dt;
        this.stats.timePlayed = this.sessionTime;
        this.updatePlaying(dt);
      } else {
        this.world.update(dt, camPos);
        this.effects.update(dt, camPos);
      }
      this.renderer.render(this.scene, this.camera);
      this.renderGunPass();
    } catch (err) {
      // surface the problem loudly instead of freezing silently
      console.error('[GAME] frame error:', err);
    }
  };

  private syncGunCamera() {
    const gc = this.gunCamera;
    gc.position.copy(this.camera.position);
    gc.quaternion.copy(this.camera.quaternion);
    if (gc.fov !== this.camera.fov || gc.aspect !== this.camera.aspect) {
      gc.fov = this.camera.fov;
      gc.aspect = this.camera.aspect;
      gc.updateProjectionMatrix();
    }
  }

  private renderGunPass() {
    this.syncGunCamera();
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCamera);
    this.renderer.autoClear = true;
  }

  private updatePlaying(dt: number) {
    const p = this.player;
    if (this.healTimer > 0) this.healTimer -= dt;
    if (this.healPool > 0 && p.health > 0) {
      const amt = Math.min(this.healPool, 26 * dt);
      this.healPool -= amt;
      p.health = Math.min(p.maxHealth, p.health + amt);
    }

    // ---- movement: room walking or duct crawling
    const frozen = this.noteOpen || this.invOpen;
    const eye = new THREE.Vector3();
    if (this.crawl) {
      if (!frozen) this.updateCrawl(dt);
      const c = this.crawl;
      if (c) {
        footholdPos(c, eye);
        eye.y += VENT_EYE + Math.sin(c.bob * 2) * 0.022 * (c.moving ? 1 : 0);
      } else {
        p.getEye(eye); // just dropped out this frame
      }
    } else {
      const wet = this.world.waterAt(p.pos);
      p.externalSpeedScale = this.weapons.moveFactor() * (wet === 2 ? 0.42 : wet === 1 ? 0.8 : 1);
      p.update(frozen ? 0 : dt, this.input, this.world);
      p.getEye(eye);
    }
    // smooth camera glide when climbing in or dropping out
    if (this.camTransition > 0) {
      this.camTransition = Math.max(0, this.camTransition - dt);
      const k = 1 - this.camTransition / 0.45;
      const ease = k * k * (3 - 2 * k);
      this.camera.position.lerpVectors(this.camFrom, eye, ease);
    } else {
      this.camera.position.copy(eye);
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const sh = this.trauma * this.trauma;
    const tNow = performance.now() * 0.001;
    const shakePitch = (Math.sin(tNow * 91) + Math.sin(tNow * 47)) * 0.0045 * sh;
    const shakeYaw = (Math.cos(tNow * 83) + Math.sin(tNow * 59)) * 0.0045 * sh;
    const crawlRoll = this.crawl ? Math.sin(this.crawl.bob) * 0.012 * (this.crawl.moving ? 1 : 0) : 0;
    this.camera.rotation.set(p.pitch + shakePitch, p.yaw + shakeYaw, Math.sin(tNow * 71) * 0.003 * sh + crawlRoll);
    this.syncGunCamera();
    this.audio.updateListener(this.camera);

    const adsDive = this.weapons.def.scoped ? this.weapons.adsAmount * 58 : this.weapons.adsAmount * 16;
    const fovTarget = this.settings.fov + p.sprintAmount * 5 * (1 - this.weapons.adsAmount) - adsDive;
    if (Math.abs(this.camera.fov - fovTarget) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fovTarget, 1 - Math.pow(0.0001, dt));
      this.camera.updateProjectionMatrix();
    }

    // ---- flashlight (stutters in the dark zones)
    if (this.flashFlicker > 0) this.flashFlicker -= dt;
    const moodId = this.world.areaAt(p.pos).id;
    const darkZone = moodId === 3 || (moodId === BLACKOUT_AREA && !this.power3On);
    let flIntensity = this.flashOn ? 14 : 0;
    if (darkZone && Math.random() < dt * 0.25) this.flashFlicker = 0.12;
    if (this.flashFlicker > 0) flIntensity *= Math.random() < 0.5 ? 0.15 : 0.6;
    this.flashlight.intensity = lerp(this.flashlight.intensity, flIntensity, 1 - Math.pow(0.000001, dt));
    this.gunKey.intensity = this.flashOn ? 2.4 : 0.85;

    // ---- weapons
    const crawlBob = this.crawl ? (this.crawl.moving ? 0.7 : 0) : (p.headBobEnabled ? p.bobAmount : 0);
    this.weapons.update(dt, {
      camera: this.camera,
      eyePos: this.camera.position.clone(),
      yaw: p.yaw,
      pitch: p.pitch,
      bobPhase: this.crawl ? this.crawl.bob : p.bobPhase,
      bobAmount: crawlBob,
      speedFactor: clamp(p.speed2D / 4.3, 0, 1.6),
      adsHeld: this.adsHeld && !frozen,
      alive: p.health > 0 && !frozen,
    });
    this.updateLock(dt, this.camera.position);

    // ---- interaction (crawl interaction is resolved inside updateCrawl)
    if (!this.crawl) this.scanInteract(this.camera.position);

    // ---- room entities (blind to a player who's up in the ducts)
    const playerEye = this.camera.position.clone();
    const ctx: EnemyContext = {
      dt,
      playerPos: p.pos.clone(),
      playerEye,
      playerNoise: frozen || this.crawl ? 0 : p.noiseRadius(),
      playerCrouching: p.crouched,
      playerHidden: !!this.crawl,
      world: this.world,
      effects: this.effects,
      audio: this.audio,
      damagePlayer: (amt, from) => { if (!this.crawl) this.damagePlayer(amt, from); },
      onDeath: (e) => {
        this.stats.kills++;
        if (Math.random() < 0.32) {
          // drops only feed weapons the player owns — and never endgame ammo
          const pool: Array<AmmoKind | 'medkit'> = [
            ...new Set(
              [...this.weapons.owned]
                .map((w) => AMMO_FOR_WEAPON[w])
                .filter((k): k is AmmoKind => k !== undefined && !RARE_AMMO.has(k)),
            ),
            'medkit',
          ];
          this.world.addDrop(pick(pool), e.pos.clone());
        }
      },
      onWatcherVanish: () => {
        this.world.triggerFlicker(0.55);
        this.audio.stinger(0.45);
      },
      onHeavySlam: () => { this.trauma = Math.min(1, this.trauma + 0.38); },
      isLookedAt: (e) => {
        if (this.crawl) return false;
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const to = e.eyePos.clone().sub(playerEye);
        if (to.length() > 36) return false;
        to.normalize();
        return dir.dot(to) > 0.9952 && this.world.lineOfSight(playerEye, e.eyePos);
      },
    };
    for (const e of this.enemies) {
      if (e.state === 'gone') continue;
      e.update(ctx);
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i];
      if (!a.alive || a.isDead) continue;
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j];
        if (!b.alive || b.isDead) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const min = a.stats.radius + b.stats.radius + 0.15;
        if (d2 < min * min && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          const nx = dx / d, nz = dz / d;
          a.pos.x -= nx * push; a.pos.z -= nz * push;
          b.pos.x += nx * push; b.pos.z += nz * push;
        }
      }
    }

    // ---- vent creatures
    if (this.ventNoiseBurst > 0) this.ventNoiseBurst -= dt;
    const lookDir = new THREE.Vector3();
    this.camera.getWorldDirection(lookDir);
    const vctx: VentMonsterContext = {
      dt,
      playerPos: this.crawl ? footholdPos(this.crawl, new THREE.Vector3()) : p.pos.clone(),
      playerEye,
      playerLookDir: lookDir,
      playerInVent: this.crawl,
      playerNoiseLevel: this.ventNoiseBurst > 0 ? 3 : this.crawl?.moving ? (this.crawl.fast ? 2 : 1) : 0,
      world: this.world,
      audio: this.audio,
      effects: this.effects,
      damagePlayer: (amt, from) => this.damagePlayer(amt, from),
      onKill: () => { this.stats.kills++; },
    };
    for (const m of this.ventMonsters) m.update(vctx);
    this.vents.update(dt);

    // ---- heavy weapons
    this.updateProjectiles(dt);
    this.updateAnomalies(dt);

    // ---- world, effects, audio
    this.world.update(dt, this.camera.position);
    this.effects.update(dt, this.camera.position);
    this.audio.update(dt, p.pos);

    let danger = p.health < 35 ? 0.5 : 0;
    for (const e of this.enemies) {
      if (!e.alive || e.isDead) continue;
      const d = e.pos.distanceTo(p.pos);
      if (e.chasing && !this.crawl) danger = Math.max(danger, clamp(1.25 - d / 17, 0, 1));
      else if (d < 8) danger = Math.max(danger, 0.3);
    }
    for (const m of this.ventMonsters) {
      if (m.alive && m.hunting) danger = Math.max(danger, clamp(1.3 - m.pos.distanceTo(vctx.playerPos) / 14, 0, 1));
    }
    this.audio.setDanger(danger);

    this.buzzTimer -= dt;
    if (this.buzzTimer <= 0) {
      this.buzzTimer = 0.12;
      const info = this.world.buzzInfo(this.camera.position);
      this.audio.setBuzz(info?.pos ?? null, (info?.intensity ?? 0) * (this.world.flickerEvent > 0 ? 0.4 : 1) * (this.crawl ? 0.4 : 1));
    }

    // ---- areas: mood follows the loose bounds, checkpoints the strict ones
    const mood = this.world.areaAt(p.pos);
    if (mood.id !== this.moodAreaIdx) {
      this.moodAreaIdx = mood.id;
      this.scene.fog = new THREE.FogExp2(mood.fogColor, mood.fog);
      (this.scene.background as THREE.Color).setHex(mood.fogColor);
      // thermal vision re-tints the world cold; entities carry the heat
      if (this.goggleMode() === 'thermal') {
        (this.scene.fog as THREE.FogExp2).color.setHex(0x0a0a30);
        (this.scene.background as THREE.Color).setHex(0x04041a);
      }
    }
    const strict = this.world.areaStrict(p.pos);
    if (strict && strict.id !== this.currentAreaIdx) {
      const first = this.currentAreaIdx !== -1;
      this.currentAreaIdx = strict.id;
      this.stats.areaName = strict.name;
      if (strict.id > this.highestArea) {
        this.highestArea = strict.id;
        this.writeSave();
        this.ui.onToast('CHECKPOINT REACHED');
      }
      if (first || strict.id > 0) this.ui.onAreaBanner(strict.name, strict.sub);
      if (strict.id >= 1 && strict.id <= AREA_THRESHOLD) {
        const cache = this.world.weaponInArea(strict);
        if (cache && !cache.taken) this.ui.onToast('SUPPLY CACHE AHEAD — A NEW WEAPON WAITS');
      }
      // the threshold alarm dies once you're down in the maintenance maze
      if (strict.id >= AREA_L4 && this.exitOpened && !this.finalOpened && this.alarmStop) {
        this.alarmStop();
        this.alarmStop = null;
      }
      this.updateObjective();
    }

    this.updateHazard(dt);

    // victory: through the final exit into the escape corridor
    if (this.finalOpened) {
      const tx = worldToTile(p.pos.x), ty = worldToTile(p.pos.z);
      if (tx >= 67 && ty >= 97 && ty <= 101) this.victory();
    }

    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    if (this.damageDirTimer > 0) this.damageDirTimer -= dt * 1.2;
    if (this.hitmarkTimer > 0) this.hitmarkTimer -= dt;
    if (this.saveFlashTimer > 0) this.saveFlashTimer -= dt;
    if (p.exhausted && p.stamina > 24 && Math.random() < dt * 2) this.audio.exhaustedBreath();

    this.updateHud();
  }

  private scanInteract(eye: THREE.Vector3) {
    if (this.noteOpen) { this.interactTarget = null; return; }
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    let best: { label: string; act: () => void } | null = null;
    let bestScore = Infinity;
    for (const it of this.world.interactables) {
      if (!it.available()) continue;
      const to = it.pos.clone().sub(eye);
      const d = to.length();
      if (d > it.radius) continue;
      to.normalize();
      const dot = camDir.dot(to);
      if (dot < 0.45) continue;
      if (it.kind !== 'door' && it.kind !== 'exit' && !this.world.lineOfSight(eye, it.pos, it.collisionOwner)) continue;
      const score = d - dot;
      if (score < bestScore) {
        bestScore = score;
        best = { label: it.label(), act: () => it.interact() };
      }
    }
    // vent grates overhead: look up at one to use it
    const portal = this.vents.portalNear(this.player.pos, 1.9);
    if (portal && camDir.y > 0.3) {
      best = portal.grateOpen
        ? { label: 'CLIMB INTO THE VENT  ·  [G] SHUT GRATE', act: () => this.enterCrawl(portal) }
        : {
          label: 'OPEN THE VENT GRATE',
          act: () => {
            portal.grateOpen = true;
            this.audio.doorMove(true, portal.roomPos.clone().setY(2.3), false);
            for (const m of this.ventMonsters) this.monsterHear(m, portal.roomPos.clone().setY(2.4), 14, false);
          },
        };
    }
    this.interactTarget = best;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRunTimers();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.boundResize);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('mousedown', this.boundMouseDown);
    window.removeEventListener('mouseup', this.boundMouseUp);
    window.removeEventListener('wheel', this.boundWheel);
    document.removeEventListener('pointerlockchange', this.boundLockChange);
    this.audio.dispose();
    this.alarmStop = null;
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
