'use strict';

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const OSU_TOKEN_URL = 'https://osu.ppy.sh/oauth/token';
const OSU_API_BASE = 'https://osu.ppy.sh/api/v2';

// Validate that credentials are configured
const CLIENT_ID = process.env.OSU_CLIENT_ID;
const CLIENT_SECRET = process.env.OSU_CLIENT_SECRET;

const credentialsMissing = !CLIENT_ID || !CLIENT_SECRET ||
  CLIENT_ID.trim() === '' || CLIENT_SECRET.trim() === '';

// ─── Token Cache ──────────────────────────────────────────────────────────────
let cachedToken = null;     // The bearer access token string
let tokenExpiresAt = 0;     // Unix timestamp (ms) when the token expires

/**
 * Fetch a new client-credentials access token from the osu! OAuth endpoint.
 * Credentials are read exclusively from environment variables.
 * The token value is never logged or returned to clients.
 */
async function fetchNewToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'public',
  });

  const response = await fetch(OSU_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 401) {
      throw Object.assign(new Error('OSU_AUTH_FAILED'), { statusCode: 401 });
    }
    throw Object.assign(new Error(`OSU_TOKEN_REQUEST_FAILED:${status}`), { statusCode: 502 });
  }

  const data = await response.json();

  // Cache the token; subtract 60 s as a safety buffer before actual expiry
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
}

/**
 * Return a valid access token, refreshing from the osu! API if necessary.
 */
async function getToken() {
  if (!cachedToken || Date.now() >= tokenExpiresAt) {
    await fetchNewToken();
  }
  return cachedToken;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Username Validation ──────────────────────────────────────────────────────
const USERNAME_REGEX = /^[a-zA-Z0-9_\- \[\]]{1,20}$/;

function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  const trimmed = username.trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  return USERNAME_REGEX.test(trimmed);
}

// ─── Game Mode Validation ────────────────────────────────────────────────────

const VALID_MODES = {
  osu: 'osu',
  taiko: 'taiko',
  fruits: 'fruits',
  mania: 'mania',
};

function validateMode(mode) {
  return typeof mode === 'string' && Object.hasOwn(VALID_MODES, mode);
}

// ─── API Proxy Endpoint ───────────────────────────────────────────────────────
// ─── Image Proxy ─────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_HOSTS = new Set([
  'a.ppy.sh',
  'assets.ppy.sh',
]);

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(400).send('Missing image URL.');
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return res.status(400).send('Invalid image URL.');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    !ALLOWED_IMAGE_HOSTS.has(parsedUrl.hostname)
  ) {
    return res.status(403).send('Image host not allowed.');
  }

  try {
    const response = await fetch(parsedUrl.toString());

    if (!response.ok) {
      return res
        .status(response.status)
        .send('Could not fetch image.');
    }

    const contentType =
      response.headers.get('content-type') || 'image/jpeg';

    const buffer = await response.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Cache-Control',
      'public, max-age=3600'
    );

    return res.send(Buffer.from(buffer));

  } catch (err) {
    console.error(
      '[BeatCard] Image proxy error:',
      err.message
    );

    return res
      .status(502)
      .send('Could not retrieve image.');
  }
});


/**
 * GET /api/user/:username
 * Fetches a player's public osu! profile and returns a safe subset of fields.
 * Never exposes credentials, tokens, or internal error details to the client.
 */
app.get('/api/user/:username/:mode', async (req, res) => {
  // ── Input validation ──────────────────────────────────────────────────────
  const rawUsername = req.params.username;
  const mode = req.params.mode;

  if (!validateUsername(rawUsername)) {
    return res.status(400).json({
      error: 'INVALID_USERNAME',
      message: 'Username must be 1–20 characters and contain only letters, numbers, spaces, underscores, hyphens, or brackets.',
    });
  }

  // ── Credential check ──────────────────────────────────────────────────────
  if (credentialsMissing) {
    return res.status(503).json({
      error: 'SERVER_NOT_CONFIGURED',
      message: 'The server is not configured with osu! API credentials. Please set OSU_CLIENT_ID and OSU_CLIENT_SECRET in the .env file.',
    });
  }

  const username = rawUsername.trim();

  try {
    // ── Obtain (or reuse) access token ────────────────────────────────────
    const token = await getToken();

    // ── Request user from osu! API ────────────────────────────────────────
    // Prefix '@' to tell the API we're looking up by username (2024 change)
    const apiUrl =
  `${OSU_API_BASE}/users/@${encodeURIComponent(username)}/${VALID_MODES[mode]}`;

    const osuRes = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    // ── Handle osu! API errors ────────────────────────────────────────────
    if (osuRes.status === 404) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: `No osu! player found with username "${username}".`,
      });
    }

    if (osuRes.status === 401) {
      // Token may have been invalidated — clear cache so next request retries
      cachedToken = null;
      tokenExpiresAt = 0;
      return res.status(502).json({
        error: 'UPSTREAM_AUTH_ERROR',
        message: 'Could not authenticate with the osu! API. Please check server credentials.',
      });
    }

    if (osuRes.status === 429) {
      return res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please wait a moment and try again.',
      });
    }

    if (!osuRes.ok) {
      return res.status(502).json({
        error: 'UPSTREAM_ERROR',
        message: 'The osu! API returned an unexpected error. Please try again later.',
      });
    }

    // ── Parse and sanitise the response ───────────────────────────────────
    let rawUser;
    try {
      rawUser = await osuRes.json();
    } catch {
      return res.status(502).json({
        error: 'INVALID_RESPONSE',
        message: 'The osu! API returned an unreadable response.',
      });
    }

    if (!rawUser || typeof rawUser !== 'object') {
      return res.status(502).json({
        error: 'UNEXPECTED_RESPONSE',
        message: 'Received an unexpected response from the osu! API.',
      });
    }

    const stats = rawUser.statistics || {};

    // ── Build safe response payload ────────────────────────────────────────
    // Only forward the fields the frontend actually needs.
    // No credentials, tokens, or internal fields are included.
    const safeUser = {
      id: rawUser.id,
      username: rawUser.username || username,

      mode: mode,

      avatar_url: rawUser.avatar_url || null,

      cover_url:
        rawUser.cover_url ||
        (rawUser.cover && rawUser.cover.url) ||
        null,

      country: {
        code:
          rawUser.country_code ||
          (rawUser.country && rawUser.country.code) ||
          null,

        name:
          (rawUser.country && rawUser.country.name) ||
          rawUser.country_code ||
          null,
      },

      statistics: {
        global_rank: stats.global_rank ?? null,
        pp: stats.pp ?? null,
        hit_accuracy: stats.hit_accuracy ?? null,
        play_count: stats.play_count ?? null,
        total_seconds_played: stats.total_seconds_played ?? null,
        ranked_score: stats.ranked_score ?? null,
        total_score: stats.total_score ?? null,
        level: stats.level || null,
      },

      is_active: rawUser.is_active ?? null,
      is_restricted: rawUser.is_restricted ?? false,
    };

    return res.json(safeUser);

  } catch (err) {
    // ── Handle auth/network failures ──────────────────────────────────────
    if (err.message === 'OSU_AUTH_FAILED') {
      return res.status(502).json({
        error: 'AUTH_FAILED',
        message: 'Could not authenticate with the osu! API. Please verify the server credentials in .env.',
      });
    }

    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      return res.status(503).json({
        error: 'NETWORK_ERROR',
        message: 'Could not reach the osu! API. Please check your internet connection.',
      });
    }

    // Generic fallback — do NOT expose error details
    console.error('[BeatCard] Unhandled error in /api/user:', err.code || err.message || 'unknown');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An internal server error occurred. Please try again.',
    });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    configured: !credentialsMissing,
  });
});

// ─── Catch-all: serve index.html for any non-API route ───────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[BeatCard] Server running at http://localhost:${PORT}`);
  if (credentialsMissing) {
    console.warn('[BeatCard] WARNING: API credentials are not configured.');
    console.warn('[BeatCard] Open .env and enter your credentials to enable player lookups.');
  } else {
    console.log('[BeatCard] API credentials loaded.');
  }
});
