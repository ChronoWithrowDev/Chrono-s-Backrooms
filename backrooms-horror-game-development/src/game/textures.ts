import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function tex(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function grime(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number, dark = true) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 8 + Math.random() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const col = dark ? '40,32,10' : '210,200,160';
    g.addColorStop(0, `rgba(${col},${alpha * Math.random()})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function streaks(ctx: CanvasRenderingContext2D, w: number, n: number) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const len = 30 + Math.random() * 140;
    const grad = ctx.createLinearGradient(x, 0, x, len);
    grad.addColorStop(0, `rgba(60,48,16,${0.05 + Math.random() * 0.12})`);
    grad.addColorStop(1, 'rgba(60,48,16,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 1 + Math.random() * 3, len);
  }
}

/** Classic mono-yellow Level 0 wallpaper with vertical stripes + motif. */
export function wallpaperYellow(): THREE.Texture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#b39d4e';
  ctx.fillRect(0, 0, 512, 512);
  // vertical stripes
  for (let x = 0; x < 512; x += 32) {
    ctx.fillStyle = x % 64 === 0 ? 'rgba(255,240,180,0.10)' : 'rgba(80,64,20,0.10)';
    ctx.fillRect(x, 0, 16, 512);
  }
  // damask-ish motif dots
  ctx.fillStyle = 'rgba(90,72,24,0.20)';
  for (let y = 24; y < 512; y += 64) {
    for (let x = 16; x < 512; x += 64) {
      const ox = (y / 64) % 2 === 0 ? 0 : 32;
      ctx.beginPath();
      ctx.ellipse(x + ox, y, 5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + ox, y + 14, 2.5, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // horizontal trim lines
  ctx.fillStyle = 'rgba(70,56,18,0.35)';
  ctx.fillRect(0, 470, 512, 4);
  ctx.fillStyle = 'rgba(255,246,200,0.18)';
  ctx.fillRect(0, 466, 512, 3);
  // bottom grime band
  const g = ctx.createLinearGradient(0, 400, 0, 512);
  g.addColorStop(0, 'rgba(50,40,12,0)');
  g.addColorStop(1, 'rgba(50,40,12,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 400, 512, 112);
  grime(ctx, 512, 512, 26, 0.16);
  streaks(ctx, 512, 22);
  return tex(c);
}

/** Grey-green service corridor wall: painted concrete blocks. */
export function wallpaperService(): THREE.Texture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#6f7263';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(30,32,24,0.5)';
  ctx.lineWidth = 3;
  for (let y = 0; y <= 512; y += 128) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
  }
  for (let y = 0; y < 512; y += 128) {
    const off = (y / 128) % 2 === 0 ? 0 : 128;
    for (let x = off; x <= 512; x += 256) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 128); ctx.stroke();
    }
  }
  // peeling paint patches
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(52,54,44,${0.12 + Math.random() * 0.2})`;
    const x = Math.random() * 512, y = Math.random() * 512;
    ctx.beginPath();
    ctx.ellipse(x, y, 14 + Math.random() * 42, 8 + Math.random() * 26, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // hazard-ish worn stripe near bottom
  ctx.fillStyle = 'rgba(140,120,40,0.35)';
  ctx.fillRect(0, 430, 512, 18);
  grime(ctx, 512, 512, 34, 0.22);
  streaks(ctx, 512, 16);
  return tex(c);
}

/** Abandoned facility: off-white panels with trim and damage. */
export function wallpaperFacility(): THREE.Texture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#8f8a76';
  ctx.fillRect(0, 0, 512, 512);
  // panel divisions
  ctx.fillStyle = 'rgba(40,38,28,0.55)';
  for (let x = 0; x <= 512; x += 128) ctx.fillRect(x - 2, 0, 4, 512);
  ctx.fillRect(0, 200, 512, 5);
  ctx.fillStyle = 'rgba(230,224,196,0.15)';
  ctx.fillRect(0, 206, 512, 3);
  // vents / scuffs
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgba(30,28,20,${0.08 + Math.random() * 0.18})`;
    ctx.fillRect(Math.random() * 512, 300 + Math.random() * 200, 8 + Math.random() * 60, 2 + Math.random() * 5);
  }
  // cracks
  ctx.strokeStyle = 'rgba(35,32,22,0.5)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 6; i++) {
    let x = Math.random() * 512, y = Math.random() * 200;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) { x += (Math.random() - 0.5) * 40; y += Math.random() * 36; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  grime(ctx, 512, 512, 30, 0.2);
  streaks(ctx, 512, 18);
  return tex(c);
}

function carpetBase(base: string, fleckA: string, fleckB: string): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  // per-pixel noise for worn carpet feel
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? fleckA : fleckB;
    ctx.globalAlpha = 0.12 + Math.random() * 0.25;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;
  grime(ctx, 256, 256, 16, 0.25);
  return tex(c);
}

export function carpetYellow(): THREE.Texture {
  const t = carpetBase('#77662f', 'rgba(214,188,105,1)', 'rgba(46,38,14,1)');
  t.repeat.set(1, 1);
  return t;
}

export function carpetDark(): THREE.Texture {
  return carpetBase('#3d3826', 'rgba(120,108,66,1)', 'rgba(16,14,8,1)');
}

export function concreteFloor(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#55534c';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(20,20,16,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 254, 254);
  // oil stains
  for (let i = 0; i < 7; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 12 + Math.random() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(18,16,12,${0.12 + Math.random() * 0.22})`);
    g.addColorStop(1, 'rgba(18,16,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(c);
}

export function ceilingTile(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#9a947f';
  ctx.fillRect(0, 0, 256, 256);
  // tile = half texture (2x2 tiles per repeat)
  ctx.strokeStyle = 'rgba(52,50,40,0.85)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, 256, 256);
  ctx.beginPath(); ctx.moveTo(128, 0); ctx.lineTo(128, 256); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 128); ctx.lineTo(256, 128); ctx.stroke();
  // pinholes
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = 'rgba(60,58,46,0.35)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4);
  }
  // water stains
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 18 + Math.random() * 52;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(122,96,44,${0.10 + Math.random() * 0.22})`);
    g.addColorStop(0.75, `rgba(122,96,44,${0.06})`);
    g.addColorStop(1, 'rgba(122,96,44,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(c);
}

export function doorTexture(locked = false): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#4c4f4d';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // recessed panel
  ctx.strokeStyle = 'rgba(16,16,14,0.8)';
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, 200, 150);
  ctx.strokeStyle = 'rgba(200,205,195,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, 192, 142);
  // small window
  ctx.fillStyle = '#14161a';
  ctx.fillRect(96, 44, 64, 84);
  ctx.strokeStyle = 'rgba(150,155,148,0.5)';
  ctx.strokeRect(96, 44, 64, 84);
  // hazard band
  for (let x = -40; x < 300; x += 40) {
    ctx.fillStyle = locked ? 'rgba(150,40,30,0.75)' : 'rgba(190,160,50,0.7)';
    ctx.beginPath();
    ctx.moveTo(x, 226); ctx.lineTo(x + 20, 206); ctx.lineTo(x + 40, 206); ctx.lineTo(x + 20, 226);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(10,10,10,0.35)';
  ctx.fillRect(0, 204, 256, 3);
  grime(ctx, 256, 256, 12, 0.25);
  return tex(c);
}

export function exitDoorTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#5a3f36';
  ctx.fillRect(0, 0, 256, 256);
  for (let x = -40; x < 300; x += 44) {
    ctx.fillStyle = 'rgba(215,180,60,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, 256); ctx.lineTo(x + 22, 214); ctx.lineTo(x + 44, 214); ctx.lineTo(x + 22, 256);
    ctx.fill();
  }
  ctx.fillStyle = '#e8e4da';
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', 128, 92);
  ctx.font = 'bold 17px monospace';
  ctx.fillText('EMERGENCY', 128, 122);
  ctx.fillStyle = '#27c24c';
  ctx.fillRect(103, 140, 50, 10);
  grime(ctx, 256, 256, 10, 0.2);
  return tex(c);
}

/** Soft radial sprite used for particles / dust / flashes. */
export function glowSprite(): THREE.Texture {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function bloodTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 26; i++) {
    const x = 24 + Math.random() * 80, y = 24 + Math.random() * 80;
    const r = 3 + Math.random() * 16;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(74,8,8,${0.35 + Math.random() * 0.4})`);
    g.addColorStop(1, 'rgba(74,8,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function paperTexture(lines: number): THREE.Texture {
  const [c, ctx] = canvas(128, 160);
  ctx.fillStyle = '#cfc9b4';
  ctx.fillRect(0, 0, 128, 160);
  ctx.fillStyle = 'rgba(60,58,48,0.75)';
  for (let i = 0; i < lines; i++) {
    const w = 60 + Math.random() * 44;
    ctx.fillRect(12, 18 + i * 13, w, 2.4);
  }
  grime(ctx, 128, 160, 5, 0.18);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------ weapon finishes

/** Blued gunmetal: brushed steel with scratches, edge wear and fouling. */
export function gunmetalTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#26282c';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 13;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n + 2;
  }
  ctx.putImageData(img, 0, 0);
  // horizontal machining / brushing lines
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * 256;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(190,200,215,${0.02 + Math.random() * 0.05})` : `rgba(0,0,0,${0.03 + Math.random() * 0.06})`;
    ctx.fillRect(0, y, 256, 1);
  }
  // scratches — bright worn metal showing through
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const len = 6 + Math.random() * 46;
    const ang = (Math.random() - 0.5) * 0.7;
    ctx.strokeStyle = `rgba(168,178,190,${0.10 + Math.random() * 0.22})`;
    ctx.lineWidth = Math.random() < 0.3 ? 1.4 : 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // carbon fouling / oil blotches
  for (let i = 0; i < 16; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 10 + Math.random() * 42;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(6,6,8,${0.08 + Math.random() * 0.16})`);
    g.addColorStop(1, 'rgba(6,6,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // worn highlights
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 6 + Math.random() * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(150,160,175,${0.05 + Math.random() * 0.09})`);
    g.addColorStop(1, 'rgba(150,160,175,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(c);
}

/** Matte stippled polymer for grips, stocks and handguards. */
export function polymerTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#191a1c';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.16)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  // grip stippling clusters
  for (let i = 0; i < 500; i++) {
    const gx = (Math.random() * 8 | 0) * 32 + 16;
    const gy = (Math.random() * 8 | 0) * 32 + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.beginPath();
    ctx.arc(gx + (Math.random() - 0.5) * 14, gy + (Math.random() - 0.5) * 14, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // scuffs
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = `rgba(140,140,135,${0.04 + Math.random() * 0.07})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 230, 3 + Math.random() * 26, 1.4);
  }
  return tex(c);
}

/** Galvanized duct steel: scratched, dusty, stained by years of stale air. */
export function ventMetalTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#565a5c';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n + 2;
  }
  ctx.putImageData(img, 0, 0);
  // panel seams + rivets
  ctx.strokeStyle = 'rgba(18,19,20,0.65)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 252, 252);
  ctx.fillStyle = 'rgba(30,31,33,0.8)';
  for (let i = 0; i < 10; i++) {
    for (const [x, y] of [[10 + i * 25, 10], [10 + i * 25, 246], [10, 10 + i * 25], [246, 10 + i * 25]] as const) {
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }
  // scratches — bright metal gouged through grime (some look deliberate)
  for (let i = 0; i < 34; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const len = 5 + Math.random() * 60;
    const ang = Math.random() < 0.4 ? Math.PI / 2 + (Math.random() - 0.5) * 0.4 : (Math.random() - 0.5) * 0.8;
    ctx.strokeStyle = `rgba(178,184,188,${0.10 + Math.random() * 0.25})`;
    ctx.lineWidth = Math.random() < 0.25 ? 1.6 : 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // dust film + grime
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = `rgba(20,18,14,${0.03 + Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  grime(ctx, 256, 256, 14, 0.16);
  return tex(c);
}

/** Worn office laminate: grain, cup rings, and restrained edge scratches. */
export function furnitureLaminateTexture(): THREE.Texture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#a69472';
  ctx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 3) {
    ctx.strokeStyle = `rgba(60,45,27,${0.025 + (y % 17) * 0.004})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.027 + y) * 2);
    ctx.stroke();
  }
  for (const [x, y, radius] of [[118, 145, 38], [127, 150, 36], [395, 366, 29]]) {
    ctx.strokeStyle = 'rgba(64,42,21,0.13)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0.2, Math.PI * 1.92);
    ctx.stroke();
  }
  for (let i = 0; i < 33; i++) {
    const x = (i * 131) % 512, y = (i * 89) % 512;
    ctx.strokeStyle = i % 2 ? 'rgba(235,217,175,0.20)' : 'rgba(57,41,26,0.19)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 12 + i % 21, y + i % 7); ctx.stroke();
  }
  return tex(c);
}

/** Muted woven upholstery, without any animated screen-noise overlay. */
export function upholsteryTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#596054';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 256; i += 4) {
    ctx.fillStyle = 'rgba(12,19,13,0.18)'; ctx.fillRect(i, 0, 1, 256);
    ctx.fillStyle = 'rgba(196,204,171,0.10)'; ctx.fillRect(0, i, 256, 1);
  }
  const wear = ctx.createRadialGradient(128, 132, 10, 128, 132, 125);
  wear.addColorStop(0, 'rgba(156,155,121,0.22)');
  wear.addColorStop(1, 'rgba(18,22,16,0.12)');
  ctx.fillStyle = wear;
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(29,35,24,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, 236, 236);
  return tex(c);
}

/** A punched-through crater: dark core, scorched ring, hairline cracks. */
export function bulletHoleTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  // scorch halo
  const halo = ctx.createRadialGradient(64, 64, 4, 64, 64, 40);
  halo.addColorStop(0, 'rgba(12,10,8,0.85)');
  halo.addColorStop(0.35, 'rgba(16,13,10,0.5)');
  halo.addColorStop(1, 'rgba(16,13,10,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 128, 128);
  // chipped ring
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
    const r = 10 + Math.random() * 7;
    ctx.fillStyle = `rgba(30,26,20,${0.35 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 1.5 + Math.random() * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // cracks
  ctx.strokeStyle = 'rgba(20,17,13,0.65)';
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    const len = 18 + Math.random() * 26;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(a) * 8, 64 + Math.sin(a) * 8);
    ctx.lineTo(64 + Math.cos(a + 0.15) * len, 64 + Math.sin(a + 0.15) * len);
    ctx.stroke();
  }
  // the hole itself
  const core = ctx.createRadialGradient(64, 64, 0, 64, 64, 10);
  core.addColorStop(0, 'rgba(0,0,0,1)');
  core.addColorStop(0.7, 'rgba(2,2,2,0.95)');
  core.addColorStop(1, 'rgba(5,4,3,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(64, 64, 10, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Oiled walnut for the shotgun furniture. */
export function woodTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#503722';
  ctx.fillRect(0, 0, 256, 256);
  // long grain waves
  for (let i = 0; i < 46; i++) {
    const yBase = Math.random() * 256;
    ctx.strokeStyle = Math.random() > 0.42 ? `rgba(30,18,8,${0.12 + Math.random() * 0.22})` : `rgba(146,102,58,${0.10 + Math.random() * 0.16})`;
    ctx.lineWidth = 0.8 + Math.random() * 2.2;
    ctx.beginPath();
    ctx.moveTo(-6, yBase);
    for (let x = 0; x <= 262; x += 22) {
      ctx.lineTo(x, yBase + Math.sin(x * 0.05 + i) * 3.2 + (Math.random() - 0.5) * 1.6);
    }
    ctx.stroke();
  }
  // knots
  for (let i = 0; i < 4; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    for (let r = 9; r > 1; r -= 2) {
      ctx.strokeStyle = `rgba(26,15,6,${0.14 + (9 - r) * 0.03})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.5, r, 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // worn sheen
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 18 + Math.random() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(214,164,102,${0.04 + Math.random() * 0.06})`);
    g.addColorStop(1, 'rgba(214,164,102,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(c);
}
