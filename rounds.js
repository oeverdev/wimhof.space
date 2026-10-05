// Playback progress, not a measurement of breathing or attendance.
import { GUIDE } from './guide-manifest.js';
export const ROUND_TIMELINE = Object.freeze(GUIDE.rounds.map(round => Object.freeze({ ...round })));

const clampUnit = value => Math.max(0, Math.min(1, value));

export function getRoundProgress(position, guide = GUIDE) {
  // Invalid player readings cannot advance the guide or create completion marks.
  const ms = Number.isFinite(position) ? Math.max(0, Math.round(position * 1000)) : 0;
  const rounds = guide.rounds.map(round => ({
    ...round,
    progress: clampUnit((ms - round.startMs) / (round.endMs - round.startMs)),
    status: ms >= round.endMs ? 'complete' : ms >= round.startMs ? 'active' : 'upcoming'
  }));
  const completedCount = rounds.filter(round => round.status === 'complete').length;
  const currentRound = rounds.find(round => round.status === 'active')?.number ?? null;
  const firstStart = guide.rounds[0].startMs;
  return {
    phase: ms < firstStart ? 'intro' : ms >= guide.durationMs ? 'complete' : completedCount === rounds.length ? 'closing' : 'round',
    currentRound,
    completedCount,
    rounds,
    totalProgress: clampUnit(ms / guide.durationMs)
  };
}
