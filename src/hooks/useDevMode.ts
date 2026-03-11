/**
 * Returns true when the URL contains the ?dev query parameter.
 * Usage: https://marurup.github.io/LabelUnWrap/?dev
 *
 * This is the only gate for developer features. No code changes are
 * needed to disable them in production — just don't use the ?dev URL.
 */
export function useDevMode(): boolean {
  return new URLSearchParams(window.location.search).has('dev')
}
