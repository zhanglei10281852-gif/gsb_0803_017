import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { ReplayView } from '../../shared/contracts';

interface TopologySceneProps {
  view: ReplayView;
  selectedService: string | null;
  selectedSpanKey: string | null;
  onSelectService: (service: string | null) => void;
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  nodeGroup: THREE.Group;
  edgeGroup: THREE.Group;
  labelGroup: THREE.Group;
  nodes: { service: string; mesh: THREE.Mesh; baseColor: THREE.Color }[];
  edges: THREE.Line[];
  rotating: boolean;
  rotationY: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
  azimuth: number;
  polar: number;
  distance: number;
  dispose: () => void;
}

function makeLabelSprite(text: string, error: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(19,26,46,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = error ? '#ff5d6c' : '#5ad1ff';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = error ? '#ff5d6c' : '#e6ecff';
  ctx.font = 'bold 28px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4, 1, 1);
  return sprite;
}

export function TopologyScene(props: TopologySceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1020');
    scene.fog = new THREE.Fog('#0b1020', 25, 70);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0x8a7bff, 0.8);
    dirLight.position.set(10, 15, 10);
    scene.add(dirLight);

    const grid = new THREE.GridHelper(40, 20, 0x283155, 0x1b2440);
    grid.position.y = -4;
    scene.add(grid);

    const nodeGroup = new THREE.Group();
    const edgeGroup = new THREE.Group();
    const labelGroup = new THREE.Group();
    scene.add(edgeGroup);
    scene.add(nodeGroup);
    scene.add(labelGroup);

    const state: SceneRefs = {
      renderer,
      scene,
      camera,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      nodeGroup,
      edgeGroup,
      labelGroup,
      nodes: [],
      edges: [],
      rotating: true,
      rotationY: 0,
      dragging: false,
      lastX: 0,
      lastY: 0,
      azimuth: 0.6,
      polar: 1.1,
      distance: 28,
      dispose: () => {}
    };
    refs.current = state;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const onPointerDown = (event: PointerEvent) => {
      state.dragging = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.rotating = false;
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!state.dragging) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.azimuth -= dx * 0.008;
      state.polar = Math.max(0.25, Math.min(Math.PI / 2 - 0.05, state.polar - dy * 0.008));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!state.dragging) return;
      state.dragging = false;
      const moved = Math.abs(event.clientX - state.lastX) + Math.abs(event.clientY - state.lastY);
      if (moved < 4) {
        const rect = renderer.domElement.getBoundingClientRect();
        state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        state.raycaster.setFromCamera(state.pointer, camera);
        const hits = state.raycaster.intersectObjects(state.nodes.map((n) => n.mesh));
        const hit = hits[0];
        const selected = hit ? (hit.object.userData['service'] as string) : null;
        propsRef.current.onSelectService(selected);
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      state.distance = Math.max(10, Math.min(60, state.distance + event.deltaY * 0.02));
    };
    const onDblClick = () => {
      state.rotating = true;
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('dblclick', onDblClick);

    const updateCamera = () => {
      const sinPolar = Math.sin(state.polar);
      camera.position.set(
        state.distance * sinPolar * Math.cos(state.azimuth),
        state.distance * Math.cos(state.polar) + 2,
        state.distance * sinPolar * Math.sin(state.azimuth)
      );
      camera.lookAt(0, 0, 0);
    };

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (state.rotating && !state.dragging) state.azimuth += 0.002;
      updateCamera();
      renderer.render(scene, camera);
    };
    animate();

    state.dispose = () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('dblclick', onDblClick);
      renderer.dispose();
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
    return () => state.dispose();
  }, []);

  useEffect(() => {
    const state = refs.current;
    if (!state) return;
    const { view, selectedService } = props;

    state.nodeGroup.clear();
    state.edgeGroup.clear();
    state.labelGroup.clear();
    state.nodes = [];
    state.edges = [];

    const nodePositions = new Map<string, THREE.Vector3>();
    for (const node of view.topology.nodes) {
      const hasError = node.errorCount > 0;
      const color = new THREE.Color(hasError ? 0xff5d6c : selectedService === node.service ? 0xffc857 : 0x5ad1ff);
      const geo = new THREE.SphereGeometry(selectedService === node.service ? 1.3 : 1, 24, 24);
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(node.position.x, node.position.y, node.position.z);
      mesh.userData['service'] = node.service;
      state.nodeGroup.add(mesh);
      state.nodes.push({ service: node.service, mesh, baseColor: color.clone() });
      nodePositions.set(node.service, mesh.position.clone());

      const label = makeLabelSprite(node.service, hasError);
      label.position.copy(mesh.position);
      label.position.y += 1.6;
      state.labelGroup.add(label);
    }

    const selectedServices = new Set<string>();
    if (selectedService) {
      selectedServices.add(selectedService);
      for (const edge of view.topology.edges) {
        if (edge.source === selectedService) selectedServices.add(edge.target);
        if (edge.target === selectedService) selectedServices.add(edge.source);
      }
    }

    for (const edge of view.topology.edges) {
      const source = nodePositions.get(edge.source);
      const target = nodePositions.get(edge.target);
      if (!source || !target) continue;
      const dimmed = selectedService && !selectedServices.has(edge.source) && !selectedServices.has(edge.target);
      const color = edge.errorCount > 0 ? 0xff5d6c : 0x8a96c0;
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: dimmed ? 0.15 : 0.9 });
      const geo = new THREE.BufferGeometry().setFromPoints([source, target]);
      const line = new THREE.Line(geo, mat);
      state.edgeGroup.add(line);
      state.edges.push(line);
    }
  }, [props.view, props.selectedService]);

  return (
    <div className="panel center" style={{ gridArea: 'center', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} data-testid="topology-canvas" />
      <div className="scene-overlay">
        <div className="overlay-chip">拖拽旋转 · 滚轮缩放 · 双击自动旋转 · 点击服务节点筛选</div>
        <div className="overlay-chip" data-testid="topology-stats">节点 {props.view.topology.nodes.length} · 调用边 {props.view.topology.edges.length}</div>
      </div>
      <div className="legend">
        <span><span className="dot" style={{ background: '#48d597' }} />正常</span>
        <span><span className="dot" style={{ background: '#ff5d6c' }} />错误传播</span>
        <span><span className="dot" style={{ background: '#ffc857' }} />选中</span>
      </div>
    </div>
  );
}
