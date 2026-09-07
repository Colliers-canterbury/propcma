// /api/config.js
// Exposes server-side environment variables to the frontend.
// The Google Maps API key is kept in Vercel env vars (never in source)
// and fetched by the app on load — users never need to paste it manually.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.json({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
  });
}
