import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildView,
  causalPath,
  CONTRACT_VERSION,
  type SpanSummaryV1,
} from "@replay/shared";
import { SpanDetails } from "./components/SpanDetails.js";
import { SpanList } from "./components/SpanList.js";
import { SessionPanel } from "./components/SessionPanel.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { Timeline } from "./components/Timeline.js";
import { TopBar } from "./components/TopBar.js";
import { Topology3D } from "./components/Topology3D.js";
import { LiveConnection } from "./live.js";
import { CollabClient, useCollab } from "./session.js";
import { ReplayStore, useReplay, type Selection } from "./state.js";
import type { TopologyScene } from "./three/scene.js";

interface ReplayWindow extends Window {
  __replay?: {
    contractVersion: number;
    store: ReplayStore;
    screenPosForService(service: string): { x: number; y: number } | null;
    highlightSummary(): { selectedService: string | null; highlightedEdges: string[]; errorEdges: string[] } | null;
  };
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function App(): React.JSX.Element {
  const [store, live, collab] = useMemo(() => {
    const s = new ReplayStore();
    const l = new LiveConnection(s);
    const c = new CollabClient(s, l);
    return [s, l, c] as const;
  }, []);
  const sceneRef = useRef<TopologyScene | null>(null);
  const snapshotOpenRef = useRef<((id: string) => void) | null>(null);

  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);

  useEffect(() => {
    (window as ReplayWindow).__replay = {
      contractVersion: CONTRACT_VERSION,
      store,
      screenPosForService: (service) => sceneRef.current?.screenPosForService(service) ?? null,
      highlightSummary: () => sceneRef.current?.getHighlightSummary() ?? null,
    };
  }, [store]);

  const snap = useReplay(store);
  const collabSnap = useCollab(collab);
  const view = useMemo(
    () => buildView(store.getEntries(), snap.cursor),
    [store, snap.version, snap.cursor],
  );
  const path = useMemo(
    () => (snap.selection ? causalPath(view.spans, snap.selection.traceId, snap.selection.spanId) : null),
    [view, snap.selection],
  );

  const parentMap = useMemo(() => {
    const m = new Map<string, SpanSummaryV1>();
    for (const s of view.spans) m.set(`${s.traceId} ${s.spanId}`, s);
    return m;
  }, [view.spans]);

  const pickRepresentative = useCallback(
    (candidates: SpanSummaryV1[]): Selection | null => {
      if (candidates.length === 0) return null;
      const errors = candidates.filter((s) => s.status === "error");
      const pool = errors.length > 0 ? errors : candidates;
      const chosen = pool[pool.length - 1];
      return chosen ? { traceId: chosen.traceId, spanId: chosen.spanId } : null;
    },
    [],
  );

  const onPickService = useCallback(
    (service: string) => {
      store.setServiceFilter(service);
      const sel = pickRepresentative(view.spans.filter((s) => s.service === service));
      store.select(sel);
    },
    [store, view.spans, pickRepresentative],
  );

  const onPickEdge = useCallback(
    (fromService: string, toService: string) => {
      const candidates = view.spans.filter((s) => {
        if (s.service !== toService || !s.parentSpanId) return false;
        const parent = parentMap.get(`${s.traceId} ${s.parentSpanId}`);
        return parent?.service === fromService;
      });
      store.select(pickRepresentative(candidates));
    },
    [store, view.spans, parentMap, pickRepresentative],
  );

  const onSelectSpan = useCallback(
    (traceId: string, spanId: string) => store.select({ traceId, spanId }),
    [store],
  );

  const isNarrow = useMediaQuery("(max-width: 920px)");
  const [sideTab, setSideTab] = useState<"list" | "details">("list");
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (snap.selection && isNarrow) setSideTab("details");
  }, [snap.selection, isNarrow]);

  const listPanel = (
    <SpanList
      spans={view.spans}
      selection={snap.selection}
      serviceFilter={snap.serviceFilter}
      domainMin={snap.domainMin}
      onSelect={onSelectSpan}
      onClearServiceFilter={() => store.setServiceFilter(null)}
    />
  );
  const detailsPanel = (
    <SpanDetails selection={snap.selection} cursor={snap.cursor} spans={view.spans} path={path} />
  );

  return (
    <div className="app">
      <TopBar snap={snap} view={view} collabRole={collabSnap.role} onToggleSnapshots={() => setDrawerOpen((v) => !v)} />
      <main className={`main${isNarrow ? " narrow" : ""}`}>
        <section className="panel topo-panel">
          <Topology3D
            view={view}
            selection={snap.selection}
            path={path}
            serviceFilter={snap.serviceFilter}
            onPickService={onPickService}
            onPickEdge={onPickEdge}
            onSceneReady={(scene) => {
              sceneRef.current = scene;
            }}
          />
        </section>
        {isNarrow ? (
          <section className="panel side-panel">
            <div className="tabs">
              <button
                type="button"
                className={`tab${sideTab === "list" ? " active" : ""}`}
                data-testid="tab-list"
                onClick={() => setSideTab("list")}
              >
                列表
              </button>
              <button
                type="button"
                className={`tab${sideTab === "details" ? " active" : ""}`}
                data-testid="tab-details"
                onClick={() => setSideTab("details")}
              >
                详情
              </button>
            </div>
            {sideTab === "list" ? listPanel : detailsPanel}
          </section>
        ) : (
          <>
            <section className="panel side-panel">{listPanel}</section>
            <section className="panel side-panel">{detailsPanel}</section>
          </>
        )}
      </main>
      <Timeline
        snap={snap}
        entries={store.getEntries()}
        lateBeyond={view.totals.lateArrivalsBeyondCursor}
        lateInPast={view.totals.lateArrivalsIntoPast}
        onScrub={(t) => store.scrubTo(t)}
        onSetIngest={(n) => store.setIngestCursor(n)}
        onToggleMode={() => (snap.mode === "live" ? store.pause() : store.resumeLive())}
        onAbsorb={() => store.absorbLatest()}
      />
      <SnapshotPanel
        open={drawerOpen}
        snap={snap}
        store={store}
        onClose={() => setDrawerOpen(false)}
        onSelectSpan={(traceId, spanId) => {
          store.select({ traceId, spanId });
          if (isNarrow) setSideTab("details");
        }}
        onRegisterOpen={(open) => {
          snapshotOpenRef.current = open;
        }}
      >
        <SessionPanel
          collab={collab}
          replaySnap={snap}
          onOpenSnapshot={(id) => snapshotOpenRef.current?.(id)}
        />
      </SnapshotPanel>
    </div>
  );
}
