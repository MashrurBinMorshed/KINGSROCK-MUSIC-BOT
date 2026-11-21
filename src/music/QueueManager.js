'use strict';

const { UserError } = require('../utils/errors');

const LOOP_MODES = Object.freeze(['off', 'track', 'queue']);

/**
 * Pure queue state for one guild. No Discord, no I/O.
 *
 * - `current`  : the track that is playing (or being started), or null
 * - `upcoming` : tracks waiting to play, in order
 * - `loopMode` : off | track | queue
 */
class QueueManager {
  constructor({ maxSize = 200, random = Math.random } = {}) {
    this.maxSize = maxSize;
    this.random = random;
    this.current = null;
    this.upcoming = [];
    this.loopMode = 'off';
  }

  get size() {
    return this.upcoming.length;
  }

  get isEmpty() {
    return this.current === null && this.upcoming.length === 0;
  }

  /** Total number of tracks (current + upcoming). */
  get total() {
    return this.upcoming.length + (this.current ? 1 : 0);
  }

  /** Remaining room in the queue. */
  get capacity() {
    return Math.max(0, this.maxSize - this.total);
  }

  /**
   * Adds tracks to the end of the queue.
   * @returns {{ added: number, dropped: number, firstPosition: number }}
   *   firstPosition is the 1-based position in `upcoming` of the first added track.
   */
  add(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (!list.length) return { added: 0, dropped: 0, firstPosition: 0 };
    const room = this.capacity;
    if (room === 0) throw new UserError(`The queue is full (max ${this.maxSize} tracks).`);
    const accepted = list.slice(0, room);
    const firstPosition = this.upcoming.length + 1;
    this.upcoming.push(...accepted);
    return { added: accepted.length, dropped: list.length - accepted.length, firstPosition };
  }

  /** Removes the track at 1-based `position` from the upcoming list. */
  remove(position) {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      throw new UserError(
        this.upcoming.length
          ? `Position must be between 1 and ${this.upcoming.length}.`
          : 'There are no upcoming tracks to remove.',
      );
    }
    const [removed] = this.upcoming.splice(position - 1, 1);
    return removed;
  }

  /** Clears upcoming tracks (the current track keeps playing). Returns how many were removed. */
  clear() {
    const count = this.upcoming.length;
    this.upcoming = [];
    return count;
  }

  /** Clears everything, including the current track. */
  reset() {
    this.current = null;
    this.upcoming = [];
  }

  /** Fisher-Yates shuffle of upcoming tracks. */
  shuffle() {
    if (this.upcoming.length < 2) throw new UserError('Add at least two upcoming tracks to shuffle.');
    const arr = this.upcoming;
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.length;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new UserError(`Loop mode must be one of: ${LOOP_MODES.join(', ')}.`);
    this.loopMode = mode;
    return mode;
  }

  /**
   * Advances the queue and returns the new current track (or null).
   *
   * @param {object} [reason]
   * @param {boolean} [reason.skipped] user skipped: never repeat the same track
   * @param {boolean} [reason.failed]  track failed: drop it from rotation
   */
  next({ skipped = false, failed = false } = {}) {
    const previous = this.current;

    if (previous && this.loopMode === 'track' && !skipped && !failed) {
      return previous; // repeat the same track
    }
    if (previous && this.loopMode === 'queue' && !failed) {
      this.upcoming.push(previous); // rotate to the end
    }
    this.current = this.upcoming.shift() || null;
    return this.current;
  }

  /** Total known duration of upcoming tracks, and whether any are live/unknown. */
  upcomingDuration() {
    let totalMs = 0;
    let unknown = 0;
    for (const t of this.upcoming) {
      if (t.durationMs && !t.isLive) totalMs += t.durationMs;
      else unknown += 1;
    }
    return { totalMs, unknown };
  }
}

module.exports = { QueueManager, LOOP_MODES };
