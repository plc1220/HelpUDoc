/**
 * How long something took, at a resolution that can express it.
 *
 * The chat used to render every duration as `${minutes}m ${seconds}s` over a
 * value floored to whole seconds. Almost nothing an agent does takes a whole
 * second — of the tool calls recorded in one deployment, 153 of 162 finished
 * under 1s, averaging 60ms — so the reading was `0m 00s` almost every time, and
 * people took it to mean the timing was broken rather than fast.
 *
 * The unit follows the magnitude: milliseconds below a second, seconds below a
 * minute, and only then minutes. A leading `0m` is never printed, because it
 * said nothing and pushed the part that mattered to the right.
 */
export const formatDurationMs = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '';
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 10) {
    // One decimal is the difference between "1s" and "1.8s" at the scale where
    // a single second is a large proportion of the whole.
    return `${(Math.round(totalSeconds * 10) / 10).toFixed(1)}s`;
  }
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - totalMinutes * 60);
  // Rounding 119.6s must read 2m 00s, not 1m 60s.
  const carriedMinutes = seconds === 60 ? totalMinutes + 1 : totalMinutes;
  const carriedSeconds = seconds === 60 ? 0 : seconds;
  if (carriedMinutes < 60) {
    return `${carriedMinutes}m ${String(carriedSeconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(carriedMinutes / 60);
  return `${hours}h ${String(carriedMinutes % 60).padStart(2, '0')}m`;
};

/**
 * The span between two timestamps, or '' when either is missing or unparseable.
 *
 * Returning '' rather than a zero keeps an unknown duration off the screen. A
 * printed `0ms` is a claim about how long something took; an absent one is not.
 */
export const formatDurationBetween = (
  startedAt?: string,
  endedAt?: string,
  now = Date.now(),
): string => {
  if (!startedAt) {
    return '';
  }
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) {
    return '';
  }
  const ended = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(ended)) {
    return '';
  }
  return formatDurationMs(Math.max(0, ended - started));
};
