import { useEffect, useRef } from "react";
import type { CausalPathV1, ReplayViewV1 } from "@replay/shared";
import { TopologyScene, type SelectionLike } from "../three/scene.js";

export interface Topology3DProps {
  view: ReplayViewV1;
  selection: SelectionLike | null;
  path: CausalPathV1 | null;
  serviceFilter: string | null;
  onPickService(service: string): void;
  onPickEdge(fromService: string, toService: string): void;
  onSceneReady(scene: TopologyScene): void;
}

export function Topology3D(props: Topology3DProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<TopologyScene | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new TopologyScene(canvas, {
      onPickService: (s) => handlersRef.current.onPickService(s),
      onPickEdge: (f, t) => handlersRef.current.onPickEdge(f, t),
    });
    sceneRef.current = scene;
    handlersRef.current.onSceneReady(scene);
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setView(props.view);
  }, [props.view]);

  useEffect(() => {
    sceneRef.current?.setSelection(props.selection, props.path, props.serviceFilter);
  }, [props.selection, props.path, props.serviceFilter]);

  return <canvas ref={canvasRef} className="topo-canvas" data-testid="topology-canvas" />;
}
