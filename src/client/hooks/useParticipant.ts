import { useCallback, useState } from 'react';

export interface Participant {
  readonly id: string;
  readonly name: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function load(): Participant {
  try {
    const raw = localStorage.getItem('investigation.participant');
    if (raw) {
      const parsed = JSON.parse(raw) as Participant;
      if (parsed.id && parsed.name) return parsed;
    }
  } catch {
    // ignore
  }
  const created: Participant = { id: randomId(), name: `值班-${Math.floor(Math.random() * 1000)}` };
  localStorage.setItem('investigation.participant', JSON.stringify(created));
  return created;
}

export function useParticipant(): {
  participant: Participant;
  setName: (name: string) => void;
} {
  const [participant, setParticipant] = useState<Participant>(() => load());
  const setName = useCallback((name: string) => {
    setParticipant((prev) => {
      const next = { id: prev.id, name };
      localStorage.setItem('investigation.participant', JSON.stringify(next));
      return next;
    });
  }, []);
  return { participant, setName };
}
