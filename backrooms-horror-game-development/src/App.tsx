import { useEffect, useRef, useState, useCallback } from 'react';
import { Game, loadSave, loadSettings, storeSettings } from './game/Game';
import { WEAPON_ORDER, WEAPONS, slotKeyLabel } from './game/weapons';
import { QUALITY_ORDER, QUALITY_LABEL, type Phase, type Settings, type GameStats, type InventorySnapshot, type GoggleKind } from './game/types';

interface Toast { id: number; text: string; warn: boolean }
interface Banner { name: string; sub: string; key: number }

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const toastId = useRef(0);
  const bannerKey = useRef(0);

  const [phase, setPhase] = useState<Phase>('menu');
  const [stats, setStats] = useState<GameStats | null>(null);
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [objective, setObjective] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [note, setNote] = useState<{ title: string; body: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hasSave, setHasSave] = useState<boolean>(() => !!loadSave());
  const [quitHint, setQuitHint] = useState(false);
  const [inv, setInv] = useState<InventorySnapshot | null>(null);

  const pushToast = useCallback((text: string, warn = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, warn }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3700);
  }, []);

  useEffect(() => {
    if (!mountRef.current || gameRef.current) return;
    const game = new Game(mountRef.current, {
      onPhase: (p, s) => {
        setPhase(p);
        if (s) setStats(s);
        if (p === 'menu') setHasSave(!!loadSave());
      },
      onObjective: (main) => setObjective(main),
      onAreaBanner: (name, sub) => {
        bannerKey.current++;
        setBanner({ name, sub, key: bannerKey.current });
      },
      onNote: (title, body) => {
        if (body === null) setNote(null);
        else setNote({ title, body });
      },
      onToast: (text, warn) => pushToast(text, warn),
      onInventory: (snapshot) => setInv(snapshot),
    }, loadSettings());
    gameRef.current = game;
    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, [pushToast]);

  const applySettings = (s: Settings) => {
    setSettingsState(s);
    storeSettings(s);
    gameRef.current?.applySettings(s);
  };

  const g = () => gameRef.current;
  const inGame = phase === 'playing';

  return (
    <div className="relative h-full w-full bg-black overflow-hidden">
      {/* 3D viewport */}
      <div ref={mountRef} className="absolute inset-0" />

      {/* a quiet vignette — the old film-grain static overlay is gone */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="crt-vignette" />
      </div>

      {/* ======================================================= HUD */}
      {inGame && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          {/* damage vignette */}
          <div
            id="hud-vignette"
            className="absolute inset-0 opacity-0"
            style={{ background: 'radial-gradient(ellipse at center, transparent 42%, rgba(160,10,5,0.55) 100%)' }}
          />
          {/* damage direction */}
          <div id="hud-dmg-dir" className="absolute left-1/2 top-1/2 opacity-0" style={{ width: 0, height: 0 }}>
            <svg width="150" height="150" viewBox="0 0 150 150" style={{ transform: 'translate(-75px,-75px)' }}>
              <path d="M55 26 L75 8 L95 26 L84 26 L84 40 L66 40 L66 26 Z" fill="rgba(255,45,30,0.85)" />
            </svg>
          </div>

          {/* crosshair + hitmarker */}
          <div id="hud-cross">
            <span className="cl t" /><span className="cl b" /><span className="cl l" /><span className="cl r" /><span className="dot" />
          </div>

          {/* sniper scope: black surround with a circular aperture + mil reticle */}
          <div
            id="hud-scope"
            className="absolute inset-0 opacity-0 pointer-events-none"
            style={{
              transition: 'opacity 90ms linear',
              background:
                'radial-gradient(circle at center, rgba(0,0,0,0) 30.5vh, rgba(2,2,2,0.995) 33vh, #000 60vh)',
            }}
          >
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '62vh', height: '62vh' }}>
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-black/85" style={{ transform: 'translateX(-0.5px)' }} />
              <div className="absolute top-1/2 left-0 right-0 h-px bg-black/85" style={{ transform: 'translateY(-0.5px)' }} />
              {/* mil dots along the horizontal wire */}
              {[-0.36, -0.24, -0.12, 0.12, 0.24, 0.36].map((k) => (
                <div
                  key={k}
                  className="absolute bg-black/85 rounded-full"
                  style={{ width: 4, height: 4, left: `calc(50% + ${k * 62}vh - 2px)`, top: 'calc(50% - 2px)' }}
                />
              ))}
              {/* range ticks down the vertical wire */}
              {[0.12, 0.24, 0.36].map((k) => (
                <div
                  key={k}
                  className="absolute bg-black/85"
                  style={{ width: 14, height: 2, left: 'calc(50% - 7px)', top: `calc(50% + ${k * 62}vh)` }}
                />
              ))}
              <div className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 0 60px rgba(0,0,0,0.55)' }} />
            </div>
          </div>
          <div id="hud-hit" className="opacity-0">
            <span className="hl a" /><span className="hl b" /><span className="hl c" /><span className="hl d" />
          </div>

          {/* night vision: phosphor green with a binocular falloff */}
          <div
            id="fx-night"
            className="absolute inset-0 opacity-0 pointer-events-none"
            style={{
              transition: 'opacity 150ms linear',
              background:
                'radial-gradient(ellipse at center, rgba(64,255,120,0.10) 40%, rgba(10,60,20,0.38) 78%, rgba(2,20,6,0.72) 100%)',
            }}
          />
          {/* thermal vision: cold indigo world, heat reads through it */}
          <div
            id="fx-thermal"
            className="absolute inset-0 opacity-0 pointer-events-none"
            style={{
              transition: 'opacity 150ms linear',
              background:
                'radial-gradient(ellipse at center, rgba(40,40,160,0.12) 45%, rgba(10,8,60,0.42) 80%, rgba(2,2,24,0.7) 100%)',
            }}
          />
          {/* HL-4 seeker + anti-matter charge readouts */}
          <div id="hud-lock" className="absolute left-1/2 top-[54%] -translate-x-1/2 text-[0.66rem] tracking-[0.35em] opacity-0" style={{ textShadow: '0 0 6px #000' }} />
          <div id="hud-charge" className="absolute left-1/2 top-[54%] -translate-x-1/2 text-[0.66rem] tracking-[0.35em] text-[#b89cff] opacity-0" style={{ textShadow: '0 0 8px #5a3cb0' }}>
            CHARGING SINGULARITY…
          </div>

          {/* interact prompt */}
          <div id="hud-prompt" className="absolute left-1/2 top-[58%] -translate-x-1/2 opacity-0 transition-opacity duration-100">
            <div className="flex items-center gap-2 bg-black/55 px-3 py-1.5 border border-[#d8d2ba]/25 backdrop-blur-[2px]">
              <span className="key-chip">E</span>
              <span id="hud-prompt-text" className="text-[0.72rem] tracking-[0.18em] text-[#e8e2cc]" />
            </div>
          </div>

          {/* objective */}
          <div className="absolute top-5 left-1/2 -translate-x-1/2 text-center w-full px-6">
            <div className="text-[0.58rem] tracking-[0.5em] text-[#d8c26a]/70">OBJECTIVE</div>
            <div className="mt-1 text-[0.8rem] tracking-[0.22em] text-[#e8e2cc]/90" style={{ textShadow: '0 2px 8px #000' }}>
              {objective}
            </div>
            <div id="hud-saved" className="mt-1 text-[0.6rem] tracking-[0.4em] text-[#8fd98a] opacity-0 transition-opacity duration-500">
              &gt;&gt; CHECKPOINT SAVED
            </div>
          </div>

          {/* bottom-left: vitals */}
          <div className="absolute left-6 bottom-6 w-60">
            <div className="flex items-end justify-between">
              <span className="text-[0.58rem] tracking-[0.35em] text-[#d8d2ba]/70">INTEGRITY</span>
              <span id="hud-medkits" className="text-[0.7rem] text-[#9fd98f]" />
            </div>
            <div className="mt-1 h-[9px] w-full bg-black/60 border border-[#d8d2ba]/25">
              <div id="hud-health-fill" className="h-full transition-[width] duration-200" style={{ width: '100%' }} />
            </div>
            <div className="mt-1.5 h-[4px] w-full bg-black/60 border border-[#d8d2ba]/15">
              <div id="hud-stamina-fill" className="h-full bg-[#a8c69f] transition-[width] duration-150" style={{ width: '100%' }} />
            </div>
            <div className="mt-2.5 flex gap-4 text-[0.6rem] tracking-[0.25em]">
              <span id="hud-keycard" className="text-[#39c2d7] opacity-20">[KEYCARD]</span>
              <span id="hud-power" className="text-[#ffd94d] opacity-20">[POWER]</span>
              <span id="hud-gold" className="text-[#e0b03a] opacity-20">[GOLD]</span>
              <span id="hud-fuse" className="text-[#ff8a3a] opacity-20">[FUSE]</span>
              <span id="hud-flashlight" className="text-[#fff1d6]">[TORCH · F]</span>
              <span id="hud-goggle" className="text-[#8affa8] opacity-25" />
            </div>
          </div>

          {/* bottom-right: weapon */}
          <div className="absolute right-6 bottom-6 text-right">
            <div id="hud-reloading" className="text-[0.62rem] tracking-[0.4em] text-[#ffd94d] opacity-0 transition-opacity">
              RELOADING…
            </div>
            <div id="hud-weapon-name" className="mt-0.5 text-[0.68rem] tracking-[0.3em] text-[#d8d2ba]/80">P229 HANDGUN</div>
            <div className="flex items-baseline justify-end gap-1.5">
              <span id="hud-ammo-mag" className="font-display text-5xl font-semibold text-[#f0e9d2]" style={{ textShadow: '0 2px 10px #000' }}>12</span>
              <span id="hud-ammo-reserve" className="text-lg text-[#d8d2ba]/60">/ 36</span>
            </div>
            <div className="mt-2 flex gap-1 justify-end flex-wrap max-w-[24rem] ml-auto">
              {WEAPON_ORDER.map((id) => (
                <div key={id} id={`hud-slot-${id}`} className="hud-slot">
                  <span className="num">{slotKeyLabel(WEAPONS[id].slot)}</span>
                  <span>{WEAPONS[id].short}</span>
                </div>
              ))}
            </div>
          </div>

          {/* toasts */}
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 w-full px-4">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`toast-anim px-4 py-1.5 text-[0.7rem] tracking-[0.25em] border backdrop-blur-[2px] ${
                  t.warn
                    ? 'bg-[#2a0705]/70 border-[#c22e2e]/50 text-[#ff9a8a]'
                    : 'bg-black/60 border-[#d8d2ba]/25 text-[#e8e2cc]'
                }`}
              >
                {t.text}
              </div>
            ))}
          </div>

          {/* area banner */}
          {banner && (
            <div key={banner.key} className="banner-anim absolute top-[24%] left-0 w-full text-center pointer-events-none">
              <div className="font-display text-3xl md:text-4xl font-semibold tracking-[0.35em] text-[#e8dfae]" style={{ textShadow: '0 0 30px rgba(216,194,106,0.4), 0 2px 6px #000' }}>
                {banner.name}
              </div>
              <div className="mt-2 text-[0.68rem] tracking-[0.3em] text-[#b6ad8d] italic">{banner.sub}</div>
              <div className="mx-auto mt-4 h-px w-64 bg-gradient-to-r from-transparent via-[#d8c26a]/60 to-transparent" />
            </div>
          )}
        </div>
      )}

      {/* ======================================================= INVENTORY (TAB) */}
      {inv && phase === 'playing' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 fade-in" onClick={() => g()?.closeInventory()}>
          <div
            className="w-[min(44rem,94vw)] max-h-[88vh] overflow-y-auto border border-[#d8c26a]/30 bg-[#0c0a06]/95 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-2xl tracking-[0.3em] text-[#e3d189]">INVENTORY</h3>
              <span className="text-[0.58rem] tracking-[0.3em] text-[#c22e2e]">THE WORLD DOES NOT WAIT — NEITHER DO THEY</span>
            </div>

            <div className="mt-4 text-[0.58rem] tracking-[0.4em] text-[#a39668]">WEAPONS — CLICK TO EQUIP</div>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-1.5">
              {inv.weapons.map((w) => (
                <button
                  key={w.id}
                  onClick={() => g()?.inventorySelect(w.id)}
                  className={`text-left border px-3 py-2 transition-colors cursor-pointer ${
                    w.current
                      ? 'border-[#d8c26a] bg-[#d8c26a]/15 text-[#f0e3ac]'
                      : 'border-[#d8d2ba]/20 bg-black/40 text-[#b6ad8d] hover:border-[#d8c26a]/60 hover:text-[#e8e2cc]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="key-chip">{w.slotLabel}</span>
                    {w.current && <span className="text-[0.55rem] tracking-[0.25em] text-[#d8c26a]">IN HAND</span>}
                  </div>
                  <div className="mt-1.5 font-display text-[0.82rem] tracking-[0.12em]">{w.name}</div>
                  <div className="text-[0.6rem] tracking-[0.2em] opacity-70">{w.detail}</div>
                </button>
              ))}
            </div>

            <div className="mt-5 text-[0.58rem] tracking-[0.4em] text-[#a39668]">GOGGLE SLOT</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                onClick={() => g()?.inventoryEquipGoggle(null)}
                className={`seg-btn ${!inv.goggles.some((x) => x.equipped) ? 'on' : ''}`}
              >
                BARE EYES
              </button>
              {inv.goggles.map((gg) => (
                <button
                  key={gg.kind}
                  disabled={!gg.owned}
                  onClick={() => g()?.inventoryEquipGoggle(gg.kind as GoggleKind)}
                  className={`seg-btn ${gg.equipped ? 'on' : ''}`}
                  style={!gg.owned ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
                >
                  {gg.kind === 'night' ? 'NIGHT VISION' : 'THERMAL'} {gg.owned ? '' : '— NOT FOUND'}
                </button>
              ))}
              <button
                onClick={() => g()?.inventoryTogglePower()}
                disabled={!inv.goggles.some((x) => x.equipped)}
                className="seg-btn"
                style={!inv.goggles.some((x) => x.equipped) ? { opacity: 0.3, cursor: 'not-allowed' } : { color: inv.goggleOn ? '#8affa8' : '#b6ad8d' }}
              >
                SIGHT: {inv.goggleOn ? 'ON' : 'OFF'} [N]
              </button>
            </div>

            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 text-[0.62rem] tracking-[0.22em] text-[#b6ad8d]">
              <span>INTEGRITY {inv.health}%</span>
              <span>MEDKITS ×{inv.medkits} [Q]</span>
              <span style={{ opacity: inv.hasKeycard ? 1 : 0.3 }}>[KEYCARD]</span>
              <span style={{ opacity: inv.hasGold ? 1 : 0.3 }}>[GOLD PASS]</span>
              <span style={{ opacity: inv.hasFuse ? 1 : 0.3 }}>[CORE FUSE]</span>
            </div>

            <div className="mt-5 flex items-center justify-between border-t border-[#d8d2ba]/15 pt-3">
              <span className="text-[0.58rem] tracking-[0.25em] text-[#8f8668]">B — CYCLE BLADES · N — TOGGLE SIGHT · CRATES HIDE BLADES &amp; GOGGLES</span>
              <button onClick={() => g()?.closeInventory()} className="seg-btn">CLOSE [TAB]</button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================= NOTE */}
      {note && phase === 'playing' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 fade-in">
          <div className="note-paper max-w-md w-[88%] rotate-[-0.6deg] p-7 pointer-events-auto">
            <div className="font-display text-sm tracking-[0.25em] border-b border-[#2c2a20]/30 pb-2">{note.title}</div>
            <p className="mt-4 text-[0.83rem] leading-relaxed whitespace-pre-line" style={{ fontFamily: '"Segoe Print", "Comic Sans MS", cursive, "Share Tech Mono", monospace' }}>
              {note.body}
            </p>
            <button
              onClick={() => g()?.closeNote()}
              className="mt-6 w-full border border-[#2c2a20]/50 py-2 text-[0.68rem] tracking-[0.3em] hover:bg-[#2c2a20] hover:text-[#cfc9b0] transition-colors cursor-pointer"
            >
              PUT IT DOWN&nbsp;&nbsp;[E]
            </button>
          </div>
        </div>
      )}

      {/* ======================================================= MAIN MENU */}
      {phase === 'menu' && (
        <div className="absolute inset-0 z-40 flex flex-col justify-between bg-gradient-to-b from-black/70 via-transparent to-black/85">
          <div className="flex items-start justify-between p-6 text-[0.6rem] tracking-[0.35em] text-[#8f8668]">
            <span>NIGHTMARE PROTOCOL // BUILD 1.0.4</span>
            <span className="hidden md:block">SIGNAL: LOST · DEPTH: UNKNOWN</span>
          </div>

          <div className="px-8 md:px-16 pb-4 max-w-2xl">
            <div className="text-[0.65rem] tracking-[0.55em] text-[#a39668] mb-2">YOU NO-CLIPPED OUT OF REALITY</div>
            <h1 className="title-flicker font-display font-bold leading-[0.95] text-[#e3d189]" style={{ fontSize: 'clamp(3rem, 8.5vw, 6.2rem)' }}>
              THE<br />BACKROOMS
            </h1>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-px w-14 bg-[#d8c26a]/70" />
              <span className="font-display text-lg md:text-xl tracking-[0.5em] text-[#cbbd84]">NIGHTMARE PROTOCOL</span>
            </div>
            <p className="mt-4 max-w-md text-[0.72rem] leading-relaxed text-[#9a9276]">
              600 million square miles of yellow wallpaper, humming lights and damp carpet.
              You have a handgun, a heartbeat, and one way out. Neither is guaranteed to last.
            </p>

            <nav className="mt-8 w-72">
              <button className="menu-btn" onClick={() => g()?.startNewGame()}>{hasSave ? 'NEW GAME' : 'PLAY'}</button>
              <button className="menu-btn" disabled={!hasSave} onClick={() => g()?.continueGame()}>CONTINUE{hasSave ? '' : ' — NO SIGNAL'}</button>
              <button className="menu-btn" onClick={() => { setShowCredits(false); setShowSettings(true); }}>SETTINGS</button>
              <button className="menu-btn" onClick={() => { setShowSettings(false); setShowCredits(true); }}>CREDITS</button>
              <button
                className="menu-btn danger"
                onClick={() => { window.close(); setQuitHint(true); }}
              >
                QUIT
              </button>
              {quitHint && <div className="mt-2 pl-6 text-[0.62rem] text-[#8f8668]">The browser holds the door shut. Close the tab to leave… if it lets you.</div>}
            </nav>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4 px-8 md:px-16 pb-6">
            <div className="text-[0.62rem] leading-loose text-[#8f8668]">
              <span className="key-chip">W</span> <span className="key-chip">A</span> <span className="key-chip">S</span> <span className="key-chip">D</span> MOVE&nbsp;&nbsp;
              <span className="key-chip">SHIFT</span> SPRINT&nbsp;&nbsp;
              <span className="key-chip">C</span> CROUCH&nbsp;&nbsp;
              <span className="key-chip">E</span> INTERACT&nbsp;&nbsp;
              <span className="key-chip">R</span> RELOAD&nbsp;&nbsp;
              <span className="key-chip">Q</span> MEDKIT&nbsp;&nbsp;
              <span className="key-chip">F</span> TORCH&nbsp;&nbsp;
              <span className="key-chip">1–0</span> WEAPONS&nbsp;&nbsp;
              <span className="key-chip">B</span> BLADES&nbsp;&nbsp;
              <span className="key-chip">TAB</span> INVENTORY&nbsp;&nbsp;
              <span className="key-chip">N</span> GOGGLES&nbsp;&nbsp;
              <span className="key-chip">G</span> VENT GRATE
            </div>
            <div className="text-[0.62rem] tracking-[0.25em] text-[#a39668]">HEADPHONES RECOMMENDED · IT LISTENS TOO</div>
          </div>

          {showSettings && (
            <SettingsPanel settings={settings} onChange={applySettings} onClose={() => setShowSettings(false)} />
          )}
          {showCredits && <CreditsPanel onClose={() => setShowCredits(false)} />}
        </div>
      )}

      {/* ======================================================= PAUSE */}
      {phase === 'paused' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-[2px] fade-in">
          <div className="w-80">
            <div className="text-[0.6rem] tracking-[0.5em] text-[#a39668]">SIGNAL HELD</div>
            <h2 className="font-display text-4xl font-semibold tracking-[0.3em] text-[#e3d189] mt-1">PAUSED</h2>
            <div className="mt-3 text-[0.65rem] text-[#8f8668] tracking-[0.15em]">
              {stats?.areaName} · KILLS {stats?.kills ?? 0} · TIME {fmtTime(stats?.timePlayed ?? 0)}
            </div>
            <nav className="mt-7">
              <button className="menu-btn" onClick={() => g()?.resumeGame()}>RESUME</button>
              <button className="menu-btn" onClick={() => setShowSettings(true)}>SETTINGS</button>
              <button className="menu-btn" onClick={() => g()?.restartFromCheckpoint()}>RESTART FROM CHECKPOINT</button>
              <button className="menu-btn danger" onClick={() => g()?.quitToMenu()}>ABANDON RUN — MAIN MENU</button>
            </nav>
            <div className="mt-6 text-[0.6rem] leading-loose text-[#6f6a55]">
              It does not pause when you do. Probably.
            </div>
          </div>
          {showSettings && (
            <SettingsPanel settings={settings} onChange={applySettings} onClose={() => setShowSettings(false)} />
          )}
        </div>
      )}

      {/* ======================================================= DEATH */}
      {phase === 'dead' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center fade-in" style={{ background: 'radial-gradient(ellipse at center, rgba(60,4,2,0.55), rgba(0,0,0,0.94) 75%)' }}>
          <div className="text-center w-[min(34rem,92vw)]">
            <div className="text-[0.62rem] tracking-[0.55em] text-[#a04038]">SIGNAL TERMINATED</div>
            <h2 className="death-anim font-display text-6xl md:text-7xl font-bold text-[#c22e2e] mt-3" style={{ textShadow: '0 0 44px rgba(194,46,46,0.45)' }}>
              YOU DIED
            </h2>
            <p className="mt-4 text-[0.72rem] text-[#9a8f78] tracking-[0.12em] leading-relaxed">
              The humming continues without you. Somewhere in the yellow,
              something stops dragging, and listens to the silence you left.
            </p>
            <StatsGrid stats={stats} />
            <nav className="mt-8 mx-auto w-80 text-left">
              <button className="menu-btn" onClick={() => g()?.restartFromCheckpoint()}>RETRY FROM CHECKPOINT</button>
              <button className="menu-btn" onClick={() => g()?.startNewGame()}>NEW RUN</button>
              <button className="menu-btn danger" onClick={() => g()?.quitToMenu()}>MAIN MENU</button>
            </nav>
          </div>
        </div>
      )}

      {/* ======================================================= VICTORY */}
      {phase === 'victory' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center fade-in" style={{ background: 'radial-gradient(ellipse at center, rgba(24,40,20,0.5), rgba(0,0,0,0.93) 78%)' }}>
          <div className="text-center w-[min(34rem,92vw)]">
            <div className="text-[0.62rem] tracking-[0.55em] text-[#8fd98a]">EMERGENCY EXIT REACHED</div>
            <h2 className="death-anim font-display text-6xl md:text-7xl font-bold text-[#bfe3b0] mt-3" style={{ textShadow: '0 0 44px rgba(120,220,110,0.35)' }}>
              YOU ESCAPED
            </h2>
            <p className="mt-4 text-[0.72rem] text-[#9a9276] tracking-[0.12em] leading-relaxed">
              Daylight. Asphalt. A parking lot that smells like rain.
              You don't look back at the building. There is no building.
              There never was. That's the worst part.
            </p>
            <StatsGrid stats={stats} />
            <nav className="mt-8 mx-auto w-80 text-left">
              <button className="menu-btn" onClick={() => g()?.startNewGame()}>DESCEND AGAIN — NEW RUN</button>
              <button className="menu-btn" onClick={() => g()?.quitToMenu()}>MAIN MENU</button>
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}

function StatsGrid({ stats }: { stats: GameStats | null }) {
  const acc = stats && stats.shotsFired > 0 ? Math.min(100, Math.round((stats.shotsHit / stats.shotsFired) * 100)) : 0;
  const cells: [string, string][] = [
    ['ENTITIES KILLED', String(stats?.kills ?? 0)],
    ['SURVIVED', fmtTime(stats?.timePlayed ?? 0)],
    ['SHOTS FIRED', String(stats?.shotsFired ?? 0)],
    ['HIT RATE', `${acc}%`],
  ];
  return (
    <div className="mt-7 grid grid-cols-4 gap-px bg-[#d8d2ba]/15 border border-[#d8d2ba]/15">
      {cells.map(([k, v]) => (
        <div key={k} className="bg-black/70 px-2 py-3">
          <div className="font-display text-xl text-[#e8e2cc]">{v}</div>
          <div className="mt-1 text-[0.52rem] tracking-[0.28em] text-[#8f8668]">{k}</div>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({ settings, onChange, onClose }: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75 fade-in" onClick={onClose}>
      <div
        className="w-[min(36rem,94vw)] border border-[#d8c26a]/30 bg-[#0c0a06]/95 p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h3 className="font-display text-2xl tracking-[0.3em] text-[#e3d189]">SETTINGS</h3>
          <span className="text-[0.58rem] tracking-[0.3em] text-[#8f8668]">APPLIED INSTANTLY</span>
        </div>

        <div className="mt-6 space-y-5 text-[0.7rem] tracking-[0.2em]">
          <div>
            <div className="flex justify-between text-[#b6ad8d]"><span>MOUSE SENSITIVITY</span><span>{settings.sensitivity.toFixed(2)}</span></div>
            <input type="range" min={0.3} max={2.5} step={0.05} value={settings.sensitivity}
              onChange={(e) => set({ sensitivity: Number(e.target.value) })} className="mt-2 w-full" />
          </div>
          <div>
            <div className="flex justify-between text-[#b6ad8d]"><span>MASTER VOLUME</span><span>{Math.round(settings.volume * 100)}%</span></div>
            <input type="range" min={0} max={1} step={0.02} value={settings.volume}
              onChange={(e) => set({ volume: Number(e.target.value) })} className="mt-2 w-full" />
          </div>
          <div>
            <div className="flex justify-between text-[#b6ad8d]"><span>FIELD OF VIEW</span><span>{settings.fov}°</span></div>
            <input type="range" min={65} max={95} step={1} value={settings.fov}
              onChange={(e) => set({ fov: Number(e.target.value) })} className="mt-2 w-full" />
          </div>
          <div>
            <div className="flex justify-between text-[#b6ad8d]">
              <span>GRAPHICS QUALITY</span>
              <span className={settings.quality === 'explode' ? 'text-[#c22e2e]' : ''}>{QUALITY_LABEL[settings.quality]}</span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {QUALITY_ORDER.filter((q) => q !== 'explode').map((q) => (
                <button key={q} className={`seg-btn ${settings.quality === q ? 'on' : ''}`} onClick={() => set({ quality: q })}>
                  {QUALITY_LABEL[q]}
                </button>
              ))}
            </div>
            <button
              className={`seg-btn mt-1.5 w-full tracking-[0.18em] ${settings.quality === 'explode' ? 'on' : ''}`}
              style={settings.quality === 'explode' ? { background: '#c22e2e', borderColor: '#c22e2e', color: '#fff4e8' } : { color: '#c98a7a', borderColor: 'rgba(194,46,46,0.4)' }}
              onClick={() => set({ quality: 'explode' })}
            >
              DO YOU WANT YOUR PC TO EXPLODE
            </button>
            {settings.quality === 'explode' && (
              <div className="mt-1.5 text-[0.58rem] tracking-[0.16em] text-[#c22e2e]">
                PIXEL RATIO 3.5 · 4K SHADOWS · 16 LIGHTS · THIS IS NOT A JOKE
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#b6ad8d]">HEAD BOB</span>
            <button className={`seg-btn ${settings.headBob ? 'on' : ''}`} onClick={() => set({ headBob: !settings.headBob })}>
              {settings.headBob ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#b6ad8d]">INVERT Y</span>
            <button className={`seg-btn ${settings.invertY ? 'on' : ''}`} onClick={() => set({ invertY: !settings.invertY })}>
              {settings.invertY ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <button onClick={onClose} className="menu-btn mt-7 border border-[#d8c26a]/30 text-center" style={{ textAlign: 'center' }}>
          CLOSE
        </button>
      </div>
    </div>
  );
}

function CreditsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75 fade-in" onClick={onClose}>
      <div className="w-[min(30rem,92vw)] border border-[#d8c26a]/30 bg-[#0c0a06]/95 p-7" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-display text-2xl tracking-[0.3em] text-[#e3d189]">CREDITS</h3>
        <div className="mt-5 space-y-3 text-[0.72rem] leading-relaxed text-[#b6ad8d]">
          <p><span className="text-[#e8e2cc]">THE BACKROOMS — NIGHTMARE PROTOCOL</span></p>
          <p>Design, code, entities &amp; endless yellow: the Nightmare Protocol team.</p>
          <p>Built with Three.js &amp; WebAudio. Every sound in the complex is synthesised live — the building hums its own soundtrack.</p>
          <p>Inspired by the Backrooms lore (origin: 4chan / Kane Pixels community works). This is a fan-made tribute.</p>
          <p className="text-[#8f8668] italic">If you hear humming, it's already too late to read this.</p>
        </div>
        <button onClick={onClose} className="menu-btn mt-6 border border-[#d8c26a]/30" style={{ textAlign: 'center' }}>
          CLOSE
        </button>
      </div>
    </div>
  );
}
