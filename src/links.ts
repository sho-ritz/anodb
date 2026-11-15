/**
 * Same-origin channel that carries an opened link (`#anodb=…`, or any other `#key=value` link such
 * as anoAuth's `#anoauth=…`) to the tab that already runs the app (a second tab cannot open the
 * database, see browserDriver's tab lock). Listeners ignore links they do not understand.
 */
export const LINK_CHANNEL = 'anodb:links'

/** Sends this page's `#…=…` link to the other tab. Returns true if there was one to send. */
export function forwardLinkToOtherTab(): boolean {
  if (typeof location === 'undefined' || typeof BroadcastChannel === 'undefined' || !/^#[A-Za-z]+=/.test(location.hash)) return false
  const ch = new BroadcastChannel(LINK_CHANNEL)
  ch.postMessage({ href: location.href })
  ch.close()
  return true
}
