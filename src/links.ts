/**
 * Same-origin channel that carries an opened `#anodb=` link to the tab that already runs the app
 * (a second tab cannot open the database, see browserDriver's tab lock).
 */
export const LINK_CHANNEL = 'anodb:links'

/** Sends this page's `#anodb=` link to the other tab. Returns true if there was one to send. */
export function forwardLinkToOtherTab(): boolean {
  if (typeof location === 'undefined' || typeof BroadcastChannel === 'undefined' || !location.hash.includes('anodb=')) return false
  const ch = new BroadcastChannel(LINK_CHANNEL)
  ch.postMessage({ href: location.href })
  ch.close()
  return true
}
