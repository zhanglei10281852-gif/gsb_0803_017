import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ProjectionView } from '../shared/contract';

interface Props {
  view: ProjectionView | null;
  selectedSpanId: string | null;
  onSelect: (spanId: string | null) => void;
}

interface NodeObj {
  spanId: string;
  mesh: THREE.Mesh;
  labelSprite: THREE.Sprite;
}

/**
 * Three.js causal topology. Spans are nodes laid out by trace (columns) and
 * depth (rows); edges are parent->child links. Errored spans and error-path
 * ancestors glow red, so an on-call viewer can trace error propagation. Node
 * selection is synced with the list/detail panels via `onSelect`.
 */
export function TopologyScene({ view, selectedSpanId, onSelect }: Props): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    nodes: NodeObj[];
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    frame: number;
    edges: THREE.Line[];
  } | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // One-time renderer/scene setup.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f1a);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    camera.position.set(0, 0, 16);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'topology-canvas');
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 8, 12);
    scene.add(dir);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const resize = (): void => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const onClick = (ev: MouseEvent): void => {
      const st = stateRef.current;
      if (!st) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(st.nodes.map((n) => n.mesh));
      if (hits.length > 0) {
        const hit = hits[0]!.object;
        const node = st.nodes.find((n) => n.mesh === hit);
        selectRef.current(node ? node.spanId : null);
      } else {
        selectRef.current(null);
      }
    };
    renderer.domElement.addEventListener('click', onClick);

    const state = {
      renderer,
      scene,
      camera,
      nodes: [] as NodeObj[],
      raycaster,
      pointer,
      frame: 0,
      edges: [] as THREE.Line[],
    };
    stateRef.current = state;

    const animate = (): void => {
      state.frame = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(state.frame);
      ro.disconnect();
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  // Rebuild graph whenever the view changes.
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !view) return;
    // Clear old objects.
    for (const n of st.nodes) {
      st.scene.remove(n.mesh);
      st.scene.remove(n.labelSprite);
      n.mesh.geometry.dispose();
      (n.mesh.material as THREE.Material).dispose();
    }
    for (const e of st.edges) {
      st.scene.remove(e);
      e.geometry.dispose();
      (e.material as THREE.Material).dispose();
    }
    st.nodes = [];
    st.edges = [];

    // Layout: group by trace into columns, depth into rows.
    const traces = [...new Set(view.spans.map((s) => s.traceId))].sort();
    const depthOf = new Map<string, number>();
    const byId = new Map(view.spans.map((s) => [s.spanId, s]));
    const computeDepth = (spanId: string, guard = new Set<string>()): number => {
      if (depthOf.has(spanId)) return depthOf.get(spanId)!;
      if (guard.has(spanId)) return 0;
      guard.add(spanId);
      const s = byId.get(spanId);
      const d = s && s.parentSpanId && byId.has(s.parentSpanId)
        ? computeDepth(s.parentSpanId, guard) + 1
        : 0;
      depthOf.set(spanId, d);
      return d;
    };
    view.spans.forEach((s) => computeDepth(s.spanId));

    const rowCount = new Map<number, number>();
    const posOf = new Map<string, THREE.Vector3>();
    for (const s of view.spans) {
      const col = traces.indexOf(s.traceId);
      const depth = depthOf.get(s.spanId) ?? 0;
      const key = col * 100 + depth;
      const within = rowCount.get(key) ?? 0;
      rowCount.set(key, within + 1);
      const x = col * 7 - (traces.length - 1) * 3.5 + within * 2.2;
      const y = 5 - depth * 3.2;
      const pos = new THREE.Vector3(x, y, 0);
      posOf.set(s.spanId, pos);
    }

    // Edges first (behind nodes).
    for (const edge of view.edges) {
      const from = posOf.get(edge.fromSpanId);
      const to = posOf.get(edge.toSpanId);
      if (!from || !to) continue;
      const geom = new THREE.BufferGeometry().setFromPoints([from, to]);
      const mat = new THREE.LineBasicMaterial({
        color: edge.propagatesError ? 0xff5a5a : 0x38507a,
      });
      const line = new THREE.Line(geom, mat);
      st.scene.add(line);
      st.edges.push(line);
    }

    // Nodes.
    for (const s of view.spans) {
      const pos = posOf.get(s.spanId)!;
      const geom = new THREE.SphereGeometry(0.62, 24, 24);
      const isError = s.status === 'error';
      const color = isError ? 0xff4d4f : s.onErrorPath ? 0xffa940 : 0x36cfc9;
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: s.spanId === selectedSpanId ? 0.9 : 0.25,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(pos);
      mesh.scale.setScalar(s.spanId === selectedSpanId ? 1.35 : 1);
      st.scene.add(mesh);

      const label = makeLabel(`${s.service}\n${s.operation} r${s.revision}`);
      label.position.copy(pos.clone().add(new THREE.Vector3(0, 1.15, 0)));
      st.scene.add(label);

      st.nodes.push({ spanId: s.spanId, mesh, labelSprite: label });
    }
  }, [view, selectedSpanId]);

  // Update highlight when selection changes without a full rebuild.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    for (const n of st.nodes) {
      const mat = n.mesh.material as THREE.MeshStandardMaterial;
      const selected = n.spanId === selectedSpanId;
      mat.emissiveIntensity = selected ? 0.9 : 0.25;
      n.mesh.scale.setScalar(selected ? 1.35 : 1);
    }
  }, [selectedSpanId]);

  return <div ref={mountRef} className="scene-mount" data-testid="scene-mount" />;
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,16,28,0.0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#dbe4f3';
  ctx.font = '22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const lines = text.split('\n');
  lines.forEach((line, i) => ctx.fillText(line, 128, 44 + i * 30));
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.4, 1.7, 1);
  return sprite;
}
