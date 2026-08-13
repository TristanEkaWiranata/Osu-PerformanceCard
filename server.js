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



// ─── BeatCard Performance Calculations ───────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function weightedAverage(values) {
  if (!values.length) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const item of values) {
    const value = Number(item.value);
    const weight = Number(item.weight);

    if (!Number.isFinite(value) || !Number.isFinite(weight)) {
      continue;
    }

    weightedSum += value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  return weightedSum / totalWeight;
}

function getAdjustedAR(baseAR, mods) {
  const hasHR = mods.includes('HR');
  const hasEZ = mods.includes('EZ');
  const hasDT = mods.includes('DT') || mods.includes('NC');
  const hasHT = mods.includes('HT');
  
  let ar = baseAR;
  if (hasHR) ar = Math.min(10, ar * 1.4);
  if (hasEZ) ar = ar * 0.5;
  
  if (hasDT) {
    let ms = ar <= 5 ? (1800 - 120 * ar) : (1200 - 150 * (ar - 5));
    ms = ms / 1.5;
    ar = ms >= 1200 ? ((1800 - ms) / 120) : (5 + (1200 - ms) / 150);
  } else if (hasHT) {
    let ms = ar <= 5 ? (1800 - 120 * ar) : (1200 - 150 * (ar - 5));
    ms = ms / 0.75;
    ar = ms >= 1200 ? ((1800 - ms) / 120) : (5 + (1200 - ms) / 150);
  }
  return ar;
}

function getAdjustedOD(baseOD, mods) {
  const hasHR = mods.includes('HR');
  const hasEZ = mods.includes('EZ');
  const hasDT = mods.includes('DT') || mods.includes('NC');
  const hasHT = mods.includes('HT');
  
  let od = baseOD;
  if (hasHR) od = Math.min(10, od * 1.4);
  if (hasEZ) od = od * 0.5;
  
  if (hasDT) {
    let ms = 80 - 6 * od;
    ms = ms / 1.5;
    od = (80 - ms) / 6;
  } else if (hasHT) {
    let ms = 80 - 6 * od;
    ms = ms / 0.75;
    od = (80 - ms) / 6;
  }
  return od;
}

/**
 * Calculate BeatCard's derived performance profile.
 *
 * These are estimates based on the player's top scores.
 * They are NOT official osu! statistics.
 */
function calculatePerformanceProfile(entries, mode) {

  // ── osu! Standard ─────────────────────────────────────────────────────────
  if (mode === 'osu') {

    const aimValues = [];
    const speedValues = [];
    const accuracyValues = [];
    const staminaRawValues = [];

    for (const entry of entries) {
      const score = entry.score;
      const beatmap = entry.beatmap;
      const attr = entry.attributes;

      const ppWeight = Number(score.pp) > 0 ? Number(score.pp) : 1;
      const accuracy = Number(score.accuracy) || 0; // decimal 0.0 to 1.0
      const misses   = Number(score.statistics?.count_miss) || 0;

      const mods = Array.isArray(score.mods)
        ? score.mods.map(m => (typeof m === 'string' ? m : m.acronym))
        : [];

      // ── Aim ───────────────────────────────────────────────────────────────
      if (Number.isFinite(Number(attr.aim_difficulty))) {
        const aimDiff = Number(attr.aim_difficulty);
        const aimQuality = clamp(Math.pow(accuracy, 2) * Math.pow(0.95, misses), 0, 1);
        const aimRaw = aimDiff * aimQuality;
        aimValues.push({ value: aimRaw, weight: ppWeight });
      }

      // ── Speed ─────────────────────────────────────────────────────────────
      if (Number.isFinite(Number(attr.speed_difficulty))) {
        const speedDiff = Number(attr.speed_difficulty);
        const speedQuality = clamp(Math.pow(accuracy, 4) * Math.pow(0.98, misses), 0, 1);
        const speedRaw = speedDiff * speedQuality;
        speedValues.push({ value: speedRaw, weight: ppWeight });
      }

      // ── Accuracy V2 ───────────────────────────────────────────────────────
      const count300 = Number(score.statistics?.count_300) || 0;
      const count100 = Number(score.statistics?.count_100) || 0;
      const count50  = Number(score.statistics?.count_50) || 0;
      const timingDenom = count300 + count100 + count50;

      const baseOD = Number(beatmap.accuracy);
      if (timingDenom > 0 && Number.isFinite(baseOD)) {
        const timingAcc = count300 / timingDenom;
        const adjustedOD = getAdjustedOD(baseOD, mods);
        const starRating = Number(attr.star_rating) || 0;
        const accuracyRaw = adjustedOD * timingAcc * (0.9 + 0.1 * Math.min(8, starRating) / 8);
        accuracyValues.push({ value: accuracyRaw, weight: ppWeight });
      }

      // ── Stamina V2 (Per-play raw calculation) ──────────────────────────────
      if (Number.isFinite(Number(attr.speed_difficulty))) {
        const speedDifficulty = Number(attr.speed_difficulty) || 0;
        const speedNoteCount  = Number(attr.speed_note_count) || 0;
        const hitLength       = Number(beatmap.hit_length) || 0;
        const staminaQualityPenalty = Math.pow(accuracy, 4) * Math.pow(0.97, misses);
        const staminaRaw = speedDifficulty * (speedNoteCount / 1000) * (1 - Math.exp(-hitLength / 150)) * staminaQualityPenalty;
        staminaRawValues.push(staminaRaw);
      }
    }

    const aimRawAvg   = weightedAverage(aimValues);
    const speedRawAvg = weightedAverage(speedValues);
    const accuracyRawAvg = weightedAverage(accuracyValues);

    // ── Stamina V2 (Model C Aggregation: Top 5 with Diminishing Weight) ──────
    staminaRawValues.sort((a, b) => b - a);
    const top5Stamina = staminaRawValues.slice(0, 5);
    let staminaRawSum = 0;
    let staminaWeightSum = 0;
    top5Stamina.forEach((val, j) => {
      const weight = Math.pow(0.90, j);
      staminaRawSum += val * weight;
      staminaWeightSum += weight;
    });
    const staminaRawWeighted = staminaWeightSum > 0 ? staminaRawSum / staminaWeightSum : 0;

    // Reference maximums
    const SMAX_AIM      = 7.5;
    const SMAX_SPEED    = 4.0;
    const SMAX_ACCURACY = 11.0;
    const SMAX_STAMINA  = 7.5;

    const scaleRating = (raw, smax) => {
      if (raw === null || raw === undefined) return null;
      const val = clamp(10 * Math.pow(raw / smax, 0.8), 0, 10);
      return Number(val.toFixed(1));
    };

    return {
      aim: scaleRating(aimRawAvg, SMAX_AIM),
      speed: scaleRating(speedRawAvg, SMAX_SPEED),
      accuracy: scaleRating(accuracyRawAvg, SMAX_ACCURACY),
      stamina: scaleRating(staminaRawWeighted, SMAX_STAMINA),
    };
  }

  // Other modes will be implemented after Standard works.
  return null;
}

// ─── Performance Profile Cache ────────────────────────────────────────────────
//
// In-memory cache keyed by "username:mode".
// Only derived performance data is stored — no tokens or credentials.
//
const PERF_CACHE_TTL_MS       = 10 * 60 * 1000; // 10 minutes
const PERFORMANCE_SCORE_LIMIT = 20;
const MIN_VALID_SCORES        = 3;


const perfCache    = new Map(); // key → { result, expiresAt }
const perfInflight = new Map(); // key → Promise  (request deduplication)

function perfCacheGet(key) {
  const entry = perfCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { perfCache.delete(key); return null; }
  return entry.result;
}

function perfCacheSet(key, result) {
  perfCache.set(key, { result, expiresAt: Date.now() + PERF_CACHE_TTL_MS });
}

// ─── Core Computation ────────────────────────────────────────────────────────

/**
 * Perform all osu! API calls and metric calculations for one player+mode.
 * Separated from the route handler so the in-flight Promise can be shared
 * across concurrent requests (request deduplication).
 */
async function computePerformanceProfile(username, mode) {
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // 1. Resolve user ID
  const userRes = await fetch(
    `${OSU_API_BASE}/users/@${encodeURIComponent(username)}/${mode}`,
    { headers }
  );

  if (userRes.status === 404) {
    const e = Object.assign(new Error('USER_NOT_FOUND'), {
      statusCode: 404,
      clientMessage: `No osu! player found with username "${username}".`,
    });
    throw e;
  }
  if (userRes.status === 401) {
    cachedToken = null; tokenExpiresAt = 0;
    throw Object.assign(new Error('UPSTREAM_AUTH_ERROR'), {
      statusCode: 502,
      clientMessage: 'Could not authenticate with the osu! API.',
    });
  }
  if (userRes.status === 429) {
    throw Object.assign(new Error('RATE_LIMITED'), {
      statusCode: 429,
      clientMessage: 'Too many requests. Please wait a moment and try again.',
    });
  }
  if (!userRes.ok) {
    throw Object.assign(new Error('UPSTREAM_ERROR'), {
      statusCode: 502,
      clientMessage: 'Could not retrieve the player profile from osu!.',
    });
  }

  const user = await userRes.json();
  if (!user || !user.id) {
    throw Object.assign(new Error('UNEXPECTED_RESPONSE'), {
      statusCode: 502,
      clientMessage: 'Received an unexpected response from the osu! API.',
    });
  }

  // 2. Fetch best scores
  const scoresUrl = new URL(`${OSU_API_BASE}/users/${user.id}/scores/best`);
  scoresUrl.searchParams.set('mode', mode);
  scoresUrl.searchParams.set('limit', String(PERFORMANCE_SCORE_LIMIT));
  scoresUrl.searchParams.set('offset', '0');
  scoresUrl.searchParams.set('legacy_only', '0');

  const scoresRes = await fetch(scoresUrl.toString(), { headers });
  if (!scoresRes.ok) {
    throw Object.assign(new Error('SCORES_REQUEST_FAILED'), {
      statusCode: 502,
      clientMessage: 'Could not retrieve the player performance scores.',
    });
  }

  const scores = await scoresRes.json();
  if (!Array.isArray(scores) || scores.length === 0) {
    return { mode, sample_size: 0, cached: false, metrics: null,
      message: 'No best scores available for this player.' };
  }

  // 3. Fetch difficulty attributes (all 10 in parallel; failures are skipped)
  const analyzed = await Promise.all(
    scores.map(async (score) => {
      const beatmapId = score.beatmap?.id ?? score.beatmap_id;
      if (!beatmapId) return null;
      try {
        const attrRes = await fetch(
          `${OSU_API_BASE}/beatmaps/${beatmapId}/attributes`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ ruleset: mode, mods: score.mods || [] }),
          }
        );
        if (!attrRes.ok) return null;
        const attrData = await attrRes.json();
        return { score, beatmap: score.beatmap || {}, attributes: attrData.attributes || {} };
      } catch { return null; }
    })
  );

  const validScores = analyzed.filter(Boolean);

  if (validScores.length < MIN_VALID_SCORES) {
    return { mode, sample_size: validScores.length, cached: false, metrics: null,
      message: 'Not enough score data to calculate a reliable performance profile.' };
  }

  // 4. Derive BeatCard metrics
  const metrics = calculatePerformanceProfile(validScores, mode);
  return { mode, sample_size: validScores.length, cached: false, metrics };
}

/**
 * Map thrown errors to safe HTTP responses. Never exposes tokens or secrets.
 */
function handlePerfError(err, res) {
  if (err.statusCode && err.clientMessage) {
    return res.status(err.statusCode).json({ error: err.message, message: err.clientMessage });
  }
  if (['ENOTFOUND','ECONNREFUSED','ETIMEDOUT'].includes(err.code)) {
    return res.status(503).json({ error: 'NETWORK_ERROR',
      message: 'Could not reach the osu! API. Please check your internet connection.' });
  }
  console.error('[BeatCard] Performance error:', err.code || err.message || 'unknown');
  return res.status(500).json({ error: 'INTERNAL_ERROR',
    message: 'Could not calculate the performance profile. Please try again.' });
}

// ─── Performance Profile Endpoint ────────────────────────────────────────────

/**
 * GET /api/user/:username/:mode/performance
 *
 * BeatCard-derived performance profile.
 * These values are estimates — NOT official osu! statistics.
 * Currently only mode=osu is supported.
 */
app.get('/api/user/:username/:mode/performance', async (req, res) => {
  const rawUsername = req.params.username;
  const mode        = req.params.mode;

  // Validate username
  if (!validateUsername(rawUsername)) {
    return res.status(400).json({
      error: 'INVALID_USERNAME',
      message: 'Username must be 1\u201320 characters and contain only letters, numbers, spaces, underscores, hyphens, or brackets.',
    });
  }

  // Validate mode (uses existing VALID_MODES object — not a Set)
  if (!Object.hasOwn(VALID_MODES, mode)) {
    return res.status(400).json({
      error: 'INVALID_MODE',
      message: `"${mode}" is not a valid osu! game mode. Valid modes: osu, taiko, fruits, mania.`,
    });
  }

  // Only osu standard is implemented for V1
  if (mode !== 'osu') {
    return res.status(501).json({
      error: 'MODE_NOT_IMPLEMENTED',
      message: `Performance profile for "${mode}" mode is not yet implemented. Only "osu" (osu! Standard) is currently supported.`,
    });
  }

  // Credential check
  if (credentialsMissing) {
    return res.status(503).json({
      error: 'SERVER_NOT_CONFIGURED',
      message: 'The server is not configured with osu! API credentials.',
    });
  }

  const username = rawUsername.trim();
  const cacheKey = `${username}:${mode}:v21`;

  // ── Cache hit ──────────────────────────────────────────────────────────────
  const hit = perfCacheGet(cacheKey);
  if (hit) return res.json({ ...hit, cached: true });

  // ── Deduplication: if already in-flight, await the same Promise ───────────
  if (perfInflight.has(cacheKey)) {
    try {
      const result = await perfInflight.get(cacheKey);
      return res.json({ ...result, cached: true });
    } catch (err) {
      return handlePerfError(err, res);
    }
  }

  // ── Start new computation ─────────────────────────────────────────────────
  const promise = computePerformanceProfile(username, mode)
    .then((result) => {
      if (result.metrics !== null) perfCacheSet(cacheKey, result);
      perfInflight.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      perfInflight.delete(cacheKey);
      throw err;
    });

  perfInflight.set(cacheKey, promise);

  try {
    const result = await promise;
    return res.json(result);
  } catch (err) {
    return handlePerfError(err, res);
  }
});

// ─── Catch-all: serve index.html for any non-API route ───────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'API route not found.',
    });
  }
});

// ─── Start / Export ───────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[BeatCard] Server running at http://localhost:${PORT}`);
    if (credentialsMissing) {
      console.warn('[BeatCard] WARNING: API credentials are not configured.');
      console.warn('[BeatCard] Open .env and enter your credentials to enable player lookups.');
    } else {
      console.log('[BeatCard] API credentials loaded.');
    }
  });
}

module.exports = app;
