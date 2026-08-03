import { useMemo, useRef } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { ReplayView, SpanView } from '@shared/contracts.js';

export interface Selection {
  traceId: string;
  spanId: string;
}

interface Topology3DProps {
  view: ReplayView;
  selected: Selection | null;
  onSelect: (sel: Selection | null) => void;
}

interface PositionedService {
  service: string;
  position: [number, number, number];
  errorCount: number;
  spanCount: number;
}

function servicePositions(services: ReplayView['services']): Map<string, PositionedService> {
  const map = new Map<string, PositionedService>();
  const radius = Math.max(4, services.length * 1.4);
  services.forEach((s, i) => {
    const angle = (i / Math.max(services.length, 1)) * Math.PI * 2 - Math.PI / 2;
    map.set(s.service, {
      service: s.service,
      position: [Math.cos(angle) * radius, Math.sin(angle) * radius, 0],
      errorCount: s.errorCount,
      spanCount: s.spanCount,
    });
  });
  return map;
}

function ServiceNode({
  ps,
  selected,
  dimmed,
  onClick,
}: {
  ps: PositionedService;
  selected: boolean;
  dimmed: boolean;
  onClick: () => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const hasError = ps.errorCount > 0;
  const color = selected ? '#ffd166' : hasError ? '#ff5d6c' : '#36d399';
  const scale = selected ? 1.25 : 1;
  return (
    <group position={ps.position}>
      <mesh
        ref={meshRef}
        scale={scale}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onClick();
        }}
        onPointerOver={() => {
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'default';
        }}
      >
        <sphereGeometry args={[0.9, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.6 : hasError ? 0.35 : 0.2}
          transparent
          opacity={dimmed ? 0.3 : 1}
        />
      </mesh>
      <Text
        position={[0, -1.5, 0]}
        fontSize={0.55}
        color="#e6ecff"
        anchorX="center"
        anchorY="top"
        outlineWidth={0.02}
        outlineColor="#0b1020"
      >
        {ps.service}
      </Text>
      <Text position={[0, 1.3, 0]} fontSize={0.4} color={hasError ? '#ff5d6c' : '#9aa7c7'} anchorX="center">
        {`${ps.spanCount} span${ps.spanCount === 1 ? '' : 's'}`}
      </Text>
    </group>
  );
}

function EdgeLine({
  from,
  to,
  hasError,
  highlighted,
}: {
  from: [number, number, number];
  to: [number, number, number];
  hasError: boolean;
  highlighted: boolean;
}) {
  const color = highlighted ? '#ffd166' : hasError ? '#ff5d6c' : '#4f8cff';
  const lineWidth = highlighted ? 3 : hasError ? 2 : 1;
  const opacity = highlighted ? 1 : hasError ? 0.8 : 0.4;
  const mid: [number, number, number] = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2 + 0.5,
  ];
  return (
    <Line
      points={[from, mid, to]}
      color={color}
      lineWidth={lineWidth}
      transparent
      opacity={opacity}
      dashed={!highlighted && !hasError}
      dashSize={0.3}
      gapSize={0.2}
    />
  );
}

function causalChainSpans(view: ReplayView, selected: Selection | null): Set<string> {
  if (!selected) return new Set();
  const byKey = new Map<string, SpanView>();
  for (const s of view.spans) {
    byKey.set(`${s.traceId}\u0000${s.spanId}`, s);
  }
  const chain = new Set<string>();
  let cur = byKey.get(`${selected.traceId}\u0000${selected.spanId}`);
  while (cur && !chain.has(`${cur.traceId}\u0000${cur.spanId}`)) {
    chain.add(`${cur.traceId}\u0000${cur.spanId}`);
    if (!cur.parentSpanId) break;
    cur = byKey.get(`${cur.traceId}\u0000${cur.parentSpanId}`);
  }
  return chain;
}

function Scene({ view, selected, onSelect }: Topology3DProps) {
  const positions = useMemo(() => servicePositions(view.services), [view.services]);
  const chain = useMemo(() => causalChainSpans(view, selected), [view, selected]);

  const selectedService = useMemo(() => {
    if (!selected) return null;
    const span = view.spans.find(
      (s) => s.traceId === selected.traceId && s.spanId === selected.spanId,
    );
    return span?.service ?? null;
  }, [view.spans, selected]);

  const handleServiceClick = (service: string) => {
    const span = view.spans.find((s) => s.service === service);
    if (span) {
      onSelect({ traceId: span.traceId, spanId: span.spanId });
    } else {
      onSelect(null);
    }
  };

  const edgeKey = (e: ReplayView['edges'][number]): string =>
    `${e.traceId}:${e.spanId}`;

  return (
    <>
      <ambientLight intensity={0.55} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-10, -10, -5]} intensity={0.3} />

      {view.edges.map((edge) => {
        const from = positions.get(edge.fromService);
        const to = positions.get(edge.toService);
        if (!from || !to) return null;
        const isChain = chain.has(`${edge.traceId}\u0000${edge.spanId}`);
        return (
          <EdgeLine
            key={edgeKey(edge)}
            from={from.position}
            to={to.position}
            hasError={edge.hasError}
            highlighted={isChain}
          />
        );
      })}

      {view.services.map((s) => {
        const ps = positions.get(s.service);
        if (!ps) return null;
        const isSel = selectedService === s.service;
        const dimmed = selected !== null && !isSel && !chainHasService(chain, view.spans, s.service);
        return (
          <ServiceNode
            key={s.service}
            ps={ps}
            selected={isSel}
            dimmed={dimmed}
            onClick={() => handleServiceClick(s.service)}
          />
        );
      })}

      <OrbitControls enableDamping dampingFactor={0.15} makeDefault />
    </>
  );
}

function chainHasService(
  chain: Set<string>,
  spans: SpanView[],
  service: string,
): boolean {
  for (const s of spans) {
    if (chain.has(`${s.traceId}\u0000${s.spanId}`) && s.service === service) return true;
  }
  return false;
}

export function Topology3D({ view, selected, onSelect }: Topology3DProps) {
  return (
    <Canvas
      camera={{ position: [0, 0, 14], fov: 55 }}
      onPointerMissed={() => onSelect(null)}
      style={{ background: 'radial-gradient(circle at 50% 40%, #141d36 0%, #0b1020 70%)' }}
    >
      <Scene view={view} selected={selected} onSelect={onSelect} />
    </Canvas>
  );
}
