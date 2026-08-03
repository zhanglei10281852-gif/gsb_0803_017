import type { SpanVersionExplanation, SpanView } from '@shared/contracts.js';
import type { Selection } from './Topology3D.js';

interface SpanDetailProps {
  selected: Selection | null;
  currentSpan: SpanView | null;
  versions: SpanVersionExplanation[];
}

function formatTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  return d.toISOString();
}

export function SpanDetail({ selected, currentSpan, versions }: SpanDetailProps) {
  if (!selected || !currentSpan) {
    return (
      <div className="panel detail-panel">
        <div className="panel-header"><span>Span detail</span></div>
        <div className="panel-body">
          <div className="empty">Select a span in the list, 3D topology, or timeline to inspect its version history and why the current revision wins.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel detail-panel">
      <div className="panel-header">
        <span>Span detail</span>
        <span className={`status-dot ${currentSpan.status}`} style={{ margin: 0 }} />
      </div>
      <div className="panel-body">
        <div className="detail-section">
          <h3>Current version</h3>
          <div className="detail-kv">
            <span className="k">Service</span><span className="v">{currentSpan.service}</span>
            <span className="k">Operation</span><span className="v">{currentSpan.operation}</span>
            <span className="k">Trace</span><span className="v">{currentSpan.traceId}</span>
            <span className="k">Span</span><span className="v">{currentSpan.spanId}</span>
            <span className="k">Parent</span><span className="v">{currentSpan.parentSpanId ?? '—'}</span>
            <span className="k">Revision</span><span className="v">{currentSpan.revision}</span>
            <span className="k">Status</span>
            <span className={`v ${currentSpan.status === 'error' ? 'error-text' : ''}`}>
              {currentSpan.status}
            </span>
            {currentSpan.errorMessage && (
              <>
                <span className="k">Error</span>
                <span className="v error-text">{currentSpan.errorMessage}</span>
              </>
            )}
            <span className="k">eventTime</span><span className="v">{formatTime(currentSpan.eventTime)}</span>
            <span className="k">ingestSeq</span><span className="v">{currentSpan.ingestSequence}</span>
            <span className="k">arrival delay</span>
            <span className={currentSpan.arrivalDelayMs > 1000 ? 'v error-text' : 'v'}>
              {currentSpan.arrivalDelayMs}ms
              {currentSpan.arrivalDelayMs > 1000 ? ' (late)' : ''}
            </span>
          </div>
        </div>

        {Object.keys(currentSpan.attributes).length > 0 && (
          <div className="detail-section">
            <h3>Attributes</h3>
            <div className="detail-kv">
              {Object.entries(currentSpan.attributes).map(([k]) => (
                <span key={k} className="k">{k}</span>
              ))}
              {Object.entries(currentSpan.attributes).map(([k, v]) => (
                <span key={k + '-v'} className="v">{v}</span>
              ))}
            </div>
          </div>
        )}

        <div className="detail-section">
          <h3>Version ledger ({versions.length})</h3>
          {versions.length === 0 ? (
            <div className="empty">No versions visible at this cursor.</div>
          ) : (
            <ul className="version-list">
              {versions.map((v) => (
                <li
                  key={v.ingestSequence}
                  className={`version-item ${v.isCurrent ? 'current' : ''} ${v.isDuplicate ? 'duplicate' : ''}`}
                >
                  <div className="v-head">
                    <span>
                      <strong>rev {v.revision}</strong>
                      {v.isCurrent && <span className="tag current">current</span>}
                      {v.isDuplicate && <span className="tag dup">duplicate</span>}
                      {v.arrivalDelayMs > 1000 && <span className="tag late">late</span>}
                    </span>
                    <span style={{ color: 'var(--text-dim)' }}>seq {v.ingestSequence}</span>
                  </div>
                  <div className="detail-kv" style={{ gridTemplateColumns: '90px 1fr', marginBottom: 4 }}>
                    <span className="k">status</span>
                    <span className={v.status === 'error' ? 'v error-text' : 'v'}>{v.status}</span>
                    <span className="k">eventTime</span><span className="v">{formatTime(v.eventTime)}</span>
                    <span className="k">delay</span><span className="v">{v.arrivalDelayMs}ms</span>
                  </div>
                  {v.errorMessage && (
                    <div className="v error-text" style={{ marginBottom: 4 }}>{v.errorMessage}</div>
                  )}
                  <div className="reason">{v.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
