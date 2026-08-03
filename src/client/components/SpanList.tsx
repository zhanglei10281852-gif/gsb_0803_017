import { CurrentSpan } from '../../shared/contracts';

interface SpanListProps {
  spans: readonly CurrentSpan[];
  selectedKey: string | null;
  onSelect: (traceId: string, spanId: string) => void;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function SpanList({ spans, selectedKey, onSelect }: SpanListProps) {
  if (spans.length === 0) {
    return <div className="empty">当前游标下没有可见 span</div>;
  }
  return (
    <ul className="span-list">
      {spans.map((span) => {
        const key = `${span.traceId}:${span.spanId}`;
        return (
          <li
            key={key}
            className={`span-item ${selectedKey === key ? 'active' : ''}`}
            onClick={() => onSelect(span.traceId, span.spanId)}
            data-testid={`span-item-${span.spanId}`}
          >
            <div className="line1">
              <span>
                <span className="svc">{span.service}</span>{' '}
                <span className="op">{span.operation}</span>
              </span>
              <span className={`stat ${span.status}`}>{span.status}</span>
            </div>
            <div className="line2">
              <span>rev {span.revision}</span>
              <span>seq {span.activeAt.ingestSequence}</span>
              <span>{formatTime(span.startTime)} → {formatTime(span.endTime)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
