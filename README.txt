# Vehicle Vision

Vehicle Vision is a lightweight single-page app that visualises TTC vehicles on a Google Map. The data is sourced from the NextBus public XML feed and is refreshed every few seconds to animate vehicle movement, heading, and identifier labels.

## Getting started

1. Provide a Google Maps JavaScript API key:
   - **Netlify:** add a `GOOGLE_MAPS_API_KEY` environment variable to your Netlify site or `netlify.toml`. The included Netlify Function (`/.netlify/functions/google-maps-key`) reads this variable at runtime so you don't have to expose it in the source code.
   - **Local development:** either run the project with `netlify dev` so the function can serve the key, or add `<meta name="google-maps-api-key" content="YOUR_KEY" />` to `index.html`/set `window.GOOGLE_MAPS_API_KEY` before `app.js` loads for quick experiments.
2. Serve the files locally (for example, with `npx serve`, `python -m http.server`, or `netlify dev`) and open the site in your browser.

Use the control panel to enter the four-digit fleet numbers you want to follow. Each vehicle you add appears in the tracked list and animates live on the map with heading-aware bus markers.
