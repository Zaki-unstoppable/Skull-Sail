const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

// ── API keys from environment ──
const SKETCHFAB_TOKEN = process.env.SKETCHFAB_TOKEN || '';
const MESHY_API_KEY = process.env.MESHY_API_KEY || '';

// ── Middleware ──
app.use(cors({ origin: /^https?:\/\/localhost(:\d+)?$/ }));
app.use(express.json());

// Simple request logger
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

// ── Upstream base URLs ──
const UPSTREAM = {
  ambientcg: 'https://ambientcg.com/api/v2/full_json',
  polyhaven: 'https://api.polyhaven.com',
  sketchfab: 'https://api.sketchfab.com/v3',
  meshy: 'https://api.meshy.ai/v2',
};

// ────────────────────────────────────────
// Helper: forward an upstream response back to the client
// ────────────────────────────────────────
function proxyResponse(upstreamRes, res) {
  res.status(upstreamRes.status);
  const ct = upstreamRes.headers.get('content-type');
  if (ct) res.set('Content-Type', ct);
  upstreamRes.body.pipe(res);
}

// ────────────────────────────────────────
// AmbientCG  (no key required)
// GET /api/ambientcg/*
// ────────────────────────────────────────
app.get('/api/ambientcg/*', async (req, res) => {
  try {
    const suffix = req.params[0] || '';
    const qs = new URLSearchParams(req.query).toString();
    const url = suffix
      ? `${UPSTREAM.ambientcg}/${suffix}${qs ? '?' + qs : ''}`
      : `${UPSTREAM.ambientcg}${qs ? '?' + qs : ''}`;

    const upstream = await fetch(url);
    proxyResponse(upstream, res);
  } catch (err) {
    console.error('ambientcg proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request to ambientCG failed', detail: err.message });
  }
});

// ────────────────────────────────────────
// Poly Haven  (no key required)
// GET /api/polyhaven/*
// ────────────────────────────────────────
app.get('/api/polyhaven/*', async (req, res) => {
  try {
    const suffix = req.params[0] || '';
    const qs = new URLSearchParams(req.query).toString();
    const url = `${UPSTREAM.polyhaven}/${suffix}${qs ? '?' + qs : ''}`;

    const upstream = await fetch(url);
    proxyResponse(upstream, res);
  } catch (err) {
    console.error('polyhaven proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request to Poly Haven failed', detail: err.message });
  }
});

// ────────────────────────────────────────
// Sketchfab  (token in Authorization header)
// GET /api/sketchfab/*
// ────────────────────────────────────────
app.get('/api/sketchfab/download/:uid', async (req, res) => {
  try {
    if (!SKETCHFAB_TOKEN) {
      return res.status(401).json({ error: 'SKETCHFAB_TOKEN not configured' });
    }

    const { uid } = req.params;

    // Step 1: request a download link from Sketchfab
    const dlMeta = await fetch(`${UPSTREAM.sketchfab}/models/${uid}/download`, {
      headers: { Authorization: `Token ${SKETCHFAB_TOKEN}` },
    });

    if (!dlMeta.ok) {
      return res.status(dlMeta.status).json({
        error: 'Sketchfab download request failed',
        detail: await dlMeta.text(),
      });
    }

    const dlData = await dlMeta.json();

    // Prefer glTF, fall back to first available format
    const format = dlData.gltf || dlData.glb || Object.values(dlData)[0];
    if (!format || !format.url) {
      return res.status(404).json({ error: 'No downloadable format found for this model' });
    }

    // Step 2: stream the actual archive back to the client
    const archive = await fetch(format.url);
    res.set('Content-Disposition', `attachment; filename="${uid}.zip"`);
    proxyResponse(archive, res);
  } catch (err) {
    console.error('sketchfab download proxy error:', err.message);
    res.status(502).json({ error: 'Sketchfab download failed', detail: err.message });
  }
});

app.get('/api/sketchfab/*', async (req, res) => {
  try {
    if (!SKETCHFAB_TOKEN) {
      return res.status(401).json({ error: 'SKETCHFAB_TOKEN not configured' });
    }

    const suffix = req.params[0] || '';
    const qs = new URLSearchParams(req.query).toString();
    const url = `${UPSTREAM.sketchfab}/${suffix}${qs ? '?' + qs : ''}`;

    const upstream = await fetch(url, {
      headers: { Authorization: `Token ${SKETCHFAB_TOKEN}` },
    });
    proxyResponse(upstream, res);
  } catch (err) {
    console.error('sketchfab proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request to Sketchfab failed', detail: err.message });
  }
});

// ────────────────────────────────────────
// Meshy  (API key in Authorization header)
// POST /api/meshy/*
// ────────────────────────────────────────
app.post('/api/meshy/*', async (req, res) => {
  try {
    if (!MESHY_API_KEY) {
      return res.status(401).json({ error: 'MESHY_API_KEY not configured' });
    }

    const suffix = req.params[0] || '';
    const url = `${UPSTREAM.meshy}/${suffix}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MESHY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    });
    proxyResponse(upstream, res);
  } catch (err) {
    console.error('meshy proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request to Meshy failed', detail: err.message });
  }
});

// ── Health check ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── 404 fallback ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`Pirate3D asset proxy running on http://localhost:${PORT}`);
  console.log(`  SKETCHFAB_TOKEN: ${SKETCHFAB_TOKEN ? 'set' : 'NOT SET'}`);
  console.log(`  MESHY_API_KEY:   ${MESHY_API_KEY ? 'set' : 'NOT SET'}`);
});
