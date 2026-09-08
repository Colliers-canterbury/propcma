// /api/streetview.js
// Proxies Google Street View Static API requests through the same origin.
// This prevents ERR_BLOCKED_BY_ORB (Chrome's Opaque Resource Blocking) which
// fires when cross-origin image responses lack CORS headers — as Google's
// Street View Static API does. Proxying makes the image same-origin to the app.
// The API key never reaches the client.
export default async function handler(req, res) {
  const { location, size = '120x80', fov = '80' } = req.query;

  if (!location) {
    res.status(400).json({ error: 'location parameter required' });
    return;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Maps API key not configured' });
    return;
  }

  const url = new URL('https://maps.googleapis.com/maps/api/streetview');
  url.searchParams.set('size', size);
  url.searchParams.set('fov', fov);
  url.searchParams.set('location', location);
  url.searchParams.set('key', key);

  try {
    const upstream = await fetch(url.toString());

    // Forward content-type (image/jpeg or image/png)
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    // Cache aggressively — street view images don't change often
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    const buf = await upstream.arrayBuffer();
    res.status(upstream.status).send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({ error: 'upstream fetch failed', detail: e.message });
  }
}
