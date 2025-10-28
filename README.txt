# Vehicle Vision

Vehicle Vision is a lightweight single-page app that visualises TTC vehicles on a Google Map. The data is sourced from the NextBus public XML feed and is refreshed every few seconds to animate vehicle movement, heading, and identifier labels.

## Getting started

1. Replace `YOUR_GOOGLE_MAPS_API_KEY` in `index.html` with a valid Google Maps JavaScript API key.
2. Serve the files locally (for example, with `npx serve` or `python -m http.server`) and open the site in your browser.

From the control panel you can select which routes to follow, optionally focus on specific vehicle IDs, and the tracker will animate their motion on the map.
