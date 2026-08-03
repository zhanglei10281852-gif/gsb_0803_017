import { SpanDetail as SpanDetailType } from '../../shared/contracts';

interface SpanDetailPanelProps {
  detail: SpanDetailType | null;
  loading: boolean;
}

function formatMs(ms: number): string {
  if (ms === 0) return '0';
  return new Date(ms).toISOString().slice(11, 23);
}

export function SpanDetailPanel({ detail, loading }: SpanDetailPanelProps) {
  if (loading) return <div className="empty">加载中…</div>;
  if (!detail) return <div className="empty">选择一个 span 查看版本与生效理由</div>;
  const { current, versions } = detail;
  const attributes = Object.entries(current.attributes);
  return (
    <div className="detail" data-testid="span-detail">
      <h3>{current.service} / {current.operation}</h3>
      <div className="kv">
        <span className="k">traceId</span><span>{current.traceId}</span>
        <span className="k">spanId</span><span>{current.spanId}</span>
        <span className="k">parentSpanId</span><span>{current.parentSpanId ?? '—'}</span>
        <span className="k">status</span><span className={`stat ${current.status}`}>{current.status}</span>
        <span className="k">kind</span><span>{current.kind}</span>
        <span className="k">revision</span><span>r{current.revision}</span>
        <span className="k">start/end</span><span>{formatMs(current.startTime)} → {formatMs(current.endTime)}</span>
        <span className="k">eventTime</span><span>{formatMs(current.eventTime)}</span>
        <span className="k">生效于 seq</span><span>{current.activeAt.ingestSequence}</span>
      </div>
      {current.errorMessage ? (
        <div className="section reason">
          <strong style={{ color: 'var(--error)' }}>error: </strong>{current.errorMessage}
        </div>
      ) : null}
      <div className="section">
        <strong>该版本为何生效</strong>
        <div className="reason" style={{ marginTop: 6 }}>
          <div className="kind">{current.effectiveReason.kind}</div>
          <div>{current.effectiveReason.detail}</div>
          <div style={{ marginTop: 4, color: 'var(--muted)' }}>
            比较了 {current.effectiveReason.comparedVersions} 个可见版本，胜出 ingestSequence = {current.effectiveReason.winningIngestSequence}
          </div>
        </div>
      </div>
      {attributes.length > 0 ? (
        <div className="section">
          <strong>attributes</strong>
          <div className="kv" style={{ marginTop: 6 }}>
            {attributes.map(([key, value]) => (
              <span key={key} style={{ display: 'contents' }}>
                <span className="k">{key}</span>
                <span>{String(value)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="section">
        <strong>版本账本（追加式，共 {versions.length} 条）</strong>
        <ul className="version-list">
          {versions.map((v) => (
            <li
              key={v.ingestSequence}
              className={`version-item ${v.selectedAtCursor ? 'winner' : ''} ${v.visibleAtCursor ? '' : 'hidden'}`}
              data-testid={`version-${v.ingestSequence}`}
            >
              <div className="vh">
                <span>seq {v.ingestSequence} · rev {v.revision} · {v.status}</span>
                <span>{v.visibleAtCursor ? (v.selectedAtCursor ? '当前' : '可见') : '未到达'}</span>
              </div>
              <div className="vr">{v.reason}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
