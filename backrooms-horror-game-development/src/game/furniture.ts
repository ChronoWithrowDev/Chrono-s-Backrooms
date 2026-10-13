import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PropCollisionIndex } from './propCollision';
import { furnitureLaminateTexture, upholsteryTexture, gunmetalTexture } from './textures';

type Triple = [number, number, number];
type Shape = 'box' | 'rounded' | 'tube';
type Finish = 'laminate' | 'edge' | 'steel' | 'paint' | 'fabric' | 'rubber' | 'paper' | 'carton';
export type FurnitureKind = 'table' | 'chair' | 'shelf';

export interface FurniturePart {
  name: string;
  shape: Shape;
  finish: Finish;
  matrix: THREE.Matrix4;
  solid: boolean;
}

const UNIT_BOUNDS = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function part(name: string, finish: Finish, size: Triple, pos: Triple, rotation: Triple = [0, 0, 0], shape: Shape = 'box', solid = true): FurniturePart {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...size),
  );
  return { name, finish, matrix, shape, solid };
}

function tube(name: string, a: Triple, b: Triple, diameter: number, finish: Finish = 'steel'): FurniturePart {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const dir = end.clone().sub(start);
  const matrix = new THREE.Matrix4().compose(
    start.add(end).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.clone().normalize()),
    new THREE.Vector3(diameter, dir.length(), diameter),
  );
  return { name, finish, matrix, shape: 'tube', solid: true };
}

function tableParts(): FurniturePart[] {
  const parts = [
    part('tabletop', 'laminate', [1.96, 0.068, 0.98], [0, 0.79, 0], [0, 0, 0], 'rounded'),
    part('front edge', 'edge', [1.91, 0.035, 0.014], [0, 0.788, 0.487]),
    part('rear edge', 'edge', [1.91, 0.035, 0.014], [0, 0.788, -0.487]),
    part('apron front', 'edge', [1.75, 0.094, 0.032], [0, 0.716, 0.385]),
    part('apron back', 'edge', [1.75, 0.094, 0.032], [0, 0.716, -0.385]),
    part('apron left', 'edge', [0.032, 0.094, 0.78], [-0.86, 0.716, 0]),
    part('apron right', 'edge', [0.032, 0.094, 0.78], [0.86, 0.716, 0]),
    part('drawer', 'edge', [0.66, 0.125, 0.43], [0.34, 0.683, 0.255]),
    part('drawer face', 'laminate', [0.67, 0.13, 0.025], [0.34, 0.683, 0.482]),
    part('drawer handle', 'steel', [0.19, 0.015, 0.023], [0.34, 0.691, 0.507], [0, 0, 0], 'rounded', false),
    part('paper stack', 'paper', [0.29, 0.012, 0.36], [-0.37, 0.83, -0.10], [0, 0.18, 0], 'box', false),
  ];
  for (const x of [-0.84, 0.84]) {
    for (const z of [-0.365, 0.365]) {
      parts.push(part(`table leg ${x}:${z}`, 'steel', [0.062, 0.744, 0.062], [x, 0.388, z]));
      parts.push(part('foot cap', 'rubber', [0.068, 0.025, 0.068], [x, 0.0125, z]));
      parts.push(part('leg mounting plate', 'steel', [0.095, 0.012, 0.095], [x, 0.75, z]));
    }
    parts.push(part('side stretcher', 'steel', [0.026, 0.028, 0.735], [x, 0.20, 0]));
  }
  return parts;
}

function chairParts(): FurniturePart[] {
  const parts = [
    part('seat cushion', 'fabric', [0.475, 0.072, 0.47], [0, 0.45, 0.04], [0, 0, 0], 'rounded'),
    part('seat frame', 'steel', [0.49, 0.028, 0.475], [0, 0.404, 0.04]),
    part('back shell', 'paint', [0.49, 0.315, 0.04], [0, 0.79, -0.258], [-0.12, 0, 0], 'rounded'),
    part('back cushion', 'fabric', [0.454, 0.283, 0.041], [0, 0.787, -0.23], [-0.12, 0, 0], 'rounded'),
  ];
  for (const side of [-1, 1]) {
    parts.push(tube(`chair front leg ${side}`, [side * 0.205, 0.42, 0.208], [side * 0.228, 0.015, 0.236], 0.031));
    parts.push(tube(`chair rear leg ${side}`, [side * 0.202, 0.942, -0.295], [side * 0.225, 0.015, -0.20], 0.032));
    parts.push(tube('chair side brace', [side * 0.222, 0.19, 0.226], [side * 0.219, 0.19, -0.218], 0.019));
    for (const z of [0.236, -0.20]) {
      parts.push(part('chair foot', 'rubber', [0.04, 0.023, 0.04], [side * 0.227, 0.0115, z], [0, 0, 0], 'rounded'));
    }
    parts.push(part('back fixing', 'steel', [0.014, 0.014, 0.008], [side * 0.18, 0.81, -0.202], [0, 0, 0], 'box', false));
  }
  parts.push(tube('front rung', [-0.222, 0.185, 0.226], [0.222, 0.185, 0.226], 0.018));
  return parts;
}

function shelfParts(): FurniturePart[] {
  const parts: FurniturePart[] = [part('shelf backing', 'paint', [1.59, 1.79, 0.018], [0, 1.03, -0.224])];
  for (const x of [-0.79, 0.79]) {
    for (const z of [-0.209, 0.209]) {
      parts.push(part('shelf upright', 'paint', [0.038, 1.98, 0.038], [x, 0.99, z]));
      parts.push(part('shelf foot', 'rubber', [0.05, 0.022, 0.05], [x, 0.011, z]));
    }
  }
  for (let i = 0; i < 4; i++) {
    const y = 0.14 + i * 0.52;
    parts.push(part('shelf tray', 'paint', [1.60, 0.031, 0.44], [0, y, 0]));
    parts.push(part('shelf front lip', 'steel', [1.60, 0.034, 0.016], [0, y - 0.004, 0.214]));
    for (const x of [-0.47, 0.30]) {
      const width = x < 0 ? 0.32 : 0.46;
      parts.push(part('archive carton', 'carton', [width, 0.24, 0.29], [x + i * 0.012, y + 0.136, -0.01]));
      parts.push(part('carton lid', 'edge', [width + 0.01, 0.025, 0.30], [x + i * 0.012, y + 0.255, -0.01]));
      parts.push(part('file label', 'paper', [width * 0.58, 0.055, 0.002], [x + i * 0.012, y + 0.15, 0.137], [0, 0, 0], 'box', false));
      parts.push(part('label text', 'rubber', [width * 0.37, 0.004, 0.002], [x + i * 0.012, y + 0.15, 0.139], [0, 0, 0], 'box', false));
    }
  }
  return parts;
}

export const FURNITURE_PARTS: Readonly<Record<FurnitureKind, readonly FurniturePart[]>> = {
  table: tableParts(), chair: chairParts(), shelf: shelfParts(),
};

/** A tipped chair is the complete model rotated onto its side and grounded. */
export function furnitureTransform(kind: FurnitureKind, x: number, z: number, yaw: number, tipped = false) {
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, tipped && kind === 'chair' ? Math.PI / 2 : 0));
  const root = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), rotation, new THREE.Vector3(1, 1, 1));
  const bounds = new THREE.Box3();
  for (const p of FURNITURE_PARTS[kind]) {
    bounds.union(UNIT_BOUNDS.clone().applyMatrix4(root.clone().multiply(p.matrix)));
  }
  root.elements[13] = -bounds.min.y;
  return root;
}

interface Batch { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }

/** Batch static furniture by finish; geometry and collision share every matrix. */
export class FurnitureBuilder {
  private readonly batches = new Map<string, Batch>();
  private readonly materials: Record<Finish, THREE.MeshStandardMaterial>;
  private readonly geometries: Record<Shape, THREE.BufferGeometry>;
  private count = 0;

  constructor(private readonly collisions: PropCollisionIndex) {
    const laminate = furnitureLaminateTexture();
    const fabric = upholsteryTexture();
    this.materials = {
      laminate: new THREE.MeshStandardMaterial({ map: laminate, roughness: 0.80, bumpMap: laminate, bumpScale: 0.0015 }),
      edge: new THREE.MeshStandardMaterial({ color: 0x65543b, roughness: 0.86 }),
      steel: new THREE.MeshStandardMaterial({ map: gunmetalTexture(), color: 0xb6b4af, roughness: 0.50, metalness: 0.65 }),
      paint: new THREE.MeshStandardMaterial({ color: 0x60675b, roughness: 0.72, metalness: 0.28 }),
      fabric: new THREE.MeshStandardMaterial({ map: fabric, roughness: 0.96, bumpMap: fabric, bumpScale: 0.002 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x22241e, roughness: 1 }),
      paper: new THREE.MeshStandardMaterial({ color: 0xbebaa6, roughness: 1 }),
      carton: new THREE.MeshStandardMaterial({ color: 0x867553, roughness: 0.96 }),
    };
    this.geometries = {
      box: new THREE.BoxGeometry(1, 1, 1),
      rounded: new RoundedBoxGeometry(1, 1, 1, 1, 0.055),
      tube: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
    };
    for (const geometry of Object.values(this.geometries)) geometry.computeBoundingBox();
  }

  add(kind: FurnitureKind, x: number, z: number, yaw: number, tipped = false) {
    const root = furnitureTransform(kind, x, z, yaw, tipped);
    const owner = `furniture-${this.count++}`;
    for (const p of FURNITURE_PARTS[kind]) {
      const matrix = root.clone().multiply(p.matrix);
      const key = `${p.shape}:${p.finish}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = { geometry: this.geometries[p.shape], material: this.materials[p.finish], matrices: [] };
        this.batches.set(key, batch);
      }
      batch.matrices.push(matrix);
      if (p.solid) this.collisions.add(matrix, batch.geometry.boundingBox!, owner, p.name);
    }
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'detailed-furniture';
    for (const [key, batch] of this.batches) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      mesh.name = key;
      batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }
}