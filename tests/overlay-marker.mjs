// Instrument the real DOM overlay only in recording tests. Keep test visuals out
// of the app and avoid changing the header layout being exercised.
export async function addOverlayMarker(page) {
  const overlay = page.getByTestId('prompter-overlay')
  await overlay.evaluate((element) => {
    if (element.querySelector('[data-testid="overlay-marker"]')) return
    const marker = document.createElement('span')
    marker.dataset.testid = 'overlay-marker'
    marker.setAttribute('aria-hidden', 'true')
    Object.assign(marker.style, {
      position: 'absolute',
      top: '8px',
      left: '8px',
      width: '14px',
      height: '14px',
      background: '#ff00ff',
      pointerEvents: 'none',
    })
    element.append(marker)
  })
  return overlay.getByTestId('overlay-marker')
}
