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

// ─── In-Memory Caches & Request Deduplication ──────────────────────────────
const attrCache = new Map();       // `${beatmapId}_${mode}_${sortedMods}` -> attributes object
const rawOsuCache = new Map();     // beatmapId -> { vP95, hyperdashRatio }
const inFlightRequests = new Map(); // key -> Promise

function parseOsuHitObjects(text) {
  const lines = text.split('\n');
  let inHitObjects = false;
  const objects = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[HitObjects]') { inHitObjects = true; continue; }
    if (inHitObjects && trimmed.startsWith('[')) { inHitObjects = false; }
    if (inHitObjects && trimmed) {
      const parts = trimmed.split(',');
      if (parts.length >= 4) {
        objects.push({ x: Number(parts[0]), y: Number(parts[1]), time: Number(parts[2]), type: Number(parts[3]) });
      }
    }
  }
  return objects;
}

function getCatcherHalfWidth(cs) {
  const scale = 305.7 * (1.0 - 0.7 * (cs - 5.0) / 5.0) * 0.5;
  return scale * 0.35;
}

function percentiles(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  if (!sorted.length) return { p95: 0 };
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return { p95: sorted[idx] };
}

async function getRawOsuMovementFeatures(beatmapId, cs = 5.0) {
  if (rawOsuCache.has(beatmapId)) {
    return rawOsuCache.get(beatmapId);
  }

  const inflightKey = `raw_osu_${beatmapId}`;
  if (inFlightRequests.has(inflightKey)) {
    return inFlightRequests.get(inflightKey);
  }

  const fetchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s safety timeout

      const res = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) return null;
      const text = await res.text();
      const objs = parseOsuHitObjects(text);
      if (objs.length < 2) return null;

      const halfWidth = getCatcherHalfWidth(cs);
      const vels = [];
      let hyperdashCount = 0;

      for (let i = 1; i < objs.length; i++) {
        const dt = Math.max(1, objs[i].time - objs[i-1].time);
        const dx = Math.abs(objs[i].x - objs[i-1].x);
        const effDist = Math.max(0, dx - halfWidth);
        const vReq = effDist / dt;

        vels.push(vReq);
        if (vReq > 1.50) hyperdashCount++;
      }

      const vP95 = percentiles(vels).p95;
      const hyperdashRatio = hyperdashCount / Math.max(1, objs.length - 1);

      const feat = { vP95, hyperdashRatio };
      rawOsuCache.set(beatmapId, feat);
      return feat;
    } catch {
      return null; // Graceful fallback on network error/timeout
    } finally {
      inFlightRequests.delete(inflightKey);
    }
  })();

  inFlightRequests.set(inflightKey, fetchPromise);
  return fetchPromise;
}

// ─── Taiko Raw Beatmap Helper & Cache ────────────────────────────────────────
const rawTaikoCache = new Map(); // `${beatmapId}_rate${rate}` -> { rhythmTransitionRate, intervalCV, p95Freq, fastIntervalRatio, totalStreamSec, longestStreamSec, fastSwitchRate, complexPatternRatio, normH4 }

function parseTaikoHitObjects(text) {
  const lines = text.split('\n');
  let inHitObjects = false;
  const objects = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[HitObjects]') { inHitObjects = true; continue; }
    if (inHitObjects && trimmed.startsWith('[')) { inHitObjects = false; }
    if (inHitObjects && trimmed) {
      const parts = trimmed.split(',');
      if (parts.length >= 5) {
        const time = Number(parts[2]);
        const type = Number(parts[3]);
        const hitSound = Number(parts[4]);

        const isCircle = (type & 1) !== 0;
        let color = 'don';
        if ((hitSound & 2) !== 0 || (hitSound & 8) !== 0) {
          color = 'kat';
        }
        const isStrong = (hitSound & 4) !== 0;

        objects.push({ time, isCircle, color, isStrong });
      }
    }
  }
  return objects;
}

async function getRawOsuTaikoFeatures(beatmapId, rate = 1.0) {
  const cacheKey = `${beatmapId}_rate${rate}`;
  if (rawTaikoCache.has(cacheKey)) {
    return rawTaikoCache.get(cacheKey);
  }

  const inflightKey = `raw_taiko_${cacheKey}`;
  if (inFlightRequests.has(inflightKey)) {
    return inFlightRequests.get(inflightKey);
  }

  const fetchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s safety timeout

      const res = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) return null;
      const text = await res.text();
      const objs = parseTaikoHitObjects(text);
      const circles = objs.filter(o => o.isCircle);
      if (circles.length < 5) return null;

      const n = circles.length;
      const intervals = [];
      const fastIntervals = [];
      let fastColorSwitches = 0;

      const fourGrams = {};
      let fourGramTotal = 0;
      let complexPatternCount = 0;

      const STREAM_THR = 130;
      const streams = [];
      let curStreamLen = 1;
      let curStreamDur = 0;
      let totalStreamDurMs = 0;
      let longestStreamMs = 0;
      let rhythmTransitions = 0;

      // Apply rate modifier to timestamps
      const times = circles.map(c => c.time / rate);

      for (let i = 1; i < n; i++) {
        const dt = Math.max(1, times[i] - times[i-1]);
        intervals.push(dt);

        const isSwitch = circles[i].color !== circles[i-1].color;

        if (dt <= STREAM_THR) {
          if (isSwitch) fastColorSwitches++;
          fastIntervals.push(dt);
          curStreamLen++;
          curStreamDur += dt;

          if (i >= 3) {
            const p4 = `${circles[i-3].color[0]}${circles[i-2].color[0]}${circles[i-1].color[0]}${circles[i].color[0]}`;
            fourGrams[p4] = (fourGrams[p4] || 0) + 1;
            fourGramTotal++;
            if (p4 !== 'dddd' && p4 !== 'kkkk' && p4 !== 'dkdk' && p4 !== 'kdkd') {
              complexPatternCount++;
            }
          }
        } else {
          if (curStreamLen >= 4) {
            streams.push({ len: curStreamLen, duration: curStreamDur });
            totalStreamDurMs += curStreamDur;
            if (curStreamDur > longestStreamMs) longestStreamMs = curStreamDur;
          }
          curStreamLen = 1;
          curStreamDur = 0;
        }

        if (i >= 2) {
          const prevDt = Math.max(1, times[i-1] - times[i-2]);
          const ratio = dt / prevDt;
          if (ratio < 0.85 || ratio > 1.18) rhythmTransitions++;
        }
      }

      if (curStreamLen >= 4) {
        streams.push({ len: curStreamLen, duration: curStreamDur });
        totalStreamDurMs += curStreamDur;
        if (curStreamDur > longestStreamMs) longestStreamMs = curStreamDur;
      }

      const sortedInt = [...intervals].sort((a, b) => a - b);
      const p05Int = sortedInt[Math.floor(0.05 * sortedInt.length)] || 100;
      const p95Freq = 1000 / Math.max(1, p05Int);
      const fastIntervalRatio = fastIntervals.length / Math.max(1, intervals.length);

      let sumInt = 0;
      for (const v of intervals) sumInt += v;
      const meanInt = sumInt / intervals.length;

      let varInt = 0;
      for (const v of intervals) varInt += Math.pow(v - meanInt, 2);
      const stdInt = Math.sqrt(varInt / intervals.length);
      const intervalCV = stdInt / Math.max(1, meanInt);
      const rhythmTransitionRate = rhythmTransitions / Math.max(1, n - 2);

      let h4 = 0;
      if (fourGramTotal > 0) {
        for (const pat in fourGrams) {
          const pr = fourGrams[pat] / fourGramTotal;
          if (pr > 0) h4 -= pr * Math.log2(pr);
        }
      }
      const normH4 = h4 / 4.0; // log2(16) = 4.0
      const complexPatternRatio = fourGramTotal > 0 ? complexPatternCount / fourGramTotal : 0;
      const fastSwitchRate = fastColorSwitches / Math.max(1, fastIntervals.length);

      const feat = {
        rhythmTransitionRate,
        intervalCV,
        p95Freq,
        fastIntervalRatio,
        totalStreamSec: totalStreamDurMs / 1000,
        longestStreamSec: longestStreamMs / 1000,
        fastSwitchRate,
        complexPatternRatio,
        normH4,
      };

      rawTaikoCache.set(cacheKey, feat);
      return feat;
    } catch {
      return null; // Graceful fallback on network error/timeout
    } finally {
      inFlightRequests.delete(inflightKey);
    }
  })();

  inFlightRequests.set(inflightKey, fetchPromise);
  return fetchPromise;
}

// ─── Beatmap Difficulty Attributes Fetcher with Cache & Deduplication ─────────
async function fetchBeatmapAttributes(beatmapId, mode, mods, token) {
  const modStr = (mods || [])
    .map(m => (typeof m === 'string' ? m : m.acronym))
    .sort()
    .join(',');
  const cacheKey = `${beatmapId}_${mode}_${modStr}`;
  if (attrCache.has(cacheKey)) {
    return attrCache.get(cacheKey);
  }

  const inflightKey = `attr_${cacheKey}`;
  if (inFlightRequests.has(inflightKey)) {
    return inFlightRequests.get(inflightKey);
  }

  const fetchPromise = (async () => {
    try {
      const res = await fetch(`${OSU_API_BASE}/beatmaps/${beatmapId}/attributes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ruleset: mode, mods: mods || [] }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const attributes = data.attributes || {};
      attrCache.set(cacheKey, attributes);
      return attributes;
    } catch {
      return null;
    } finally {
      inFlightRequests.delete(inflightKey);
    }
  })();

  inFlightRequests.set(inflightKey, fetchPromise);
  return fetchPromise;
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

      // ── Stamina V2 (Candidate D: Hybrid Log-Scaled Tapping Model) ──────────
      if (Number.isFinite(Number(attr.speed_difficulty))) {
        const speedDifficulty = Number(attr.speed_difficulty) || 0;
        const speedNoteCount  = Number(attr.speed_note_count) || 0;
        const hitLength       = Number(beatmap.hit_length) || 0;
        const noteScale       = Math.log10(1 + speedNoteCount / 150.0);
        const durationFactor  = 1 - Math.exp(-hitLength / 120.0);
        const staminaQuality  = Math.pow(accuracy, 3) * Math.pow(0.97, misses);
        const staminaRaw      = speedDifficulty * (0.50 + noteScale) * durationFactor * staminaQuality;
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
    const SMAX_STAMINA  = 6.5;

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

  // ── osu!mania ─────────────────────────────────────────────────────────────
  if (mode === 'mania') {
    const speedValues = [];
    const accuracyValues = [];
    const staminaRawValues = [];
    const lnRawValues = [];
    let lnHeavyCount = 0;

    for (const entry of entries) {
      const score = entry.score;
      const beatmap = entry.beatmap;
      const attr = entry.attributes;

      const ppWeight = Number(score.pp) > 0 ? Number(score.pp) : 1;
      const accuracy = Number(score.accuracy) || 0; // decimal 0.0 to 1.0
      const misses   = Number(score.statistics?.count_miss) || 0;
      const starRating = Number(attr.star_rating) || Number(beatmap.difficulty_rating) || 0;

      const mods = Array.isArray(score.mods)
        ? score.mods.map(m => (typeof m === 'string' ? m : m.acronym))
        : [];

      const isDT = mods.includes('DT') || mods.includes('NC');
      const isHT = mods.includes('HT');

      const baseHitLen = Number(beatmap.hit_length) || Number(beatmap.total_length) || 1;
      const effHitLen  = isDT ? baseHitLen / 1.5 : isHT ? baseHitLen / 0.75 : baseHitLen;

      const circles = Number(beatmap.count_circles) || 0;
      const sliders = Number(beatmap.count_sliders) || 0;
      const totalObjects = circles + sliders;

      // Skip plays where object count cannot be determined (avoids division by zero).
      if (totalObjects <= 0) continue;

      const noteDensity = totalObjects / Math.max(1, effHitLen);
      const lnRatio = sliders / totalObjects;

      if (lnRatio >= 0.30) {
        lnHeavyCount++;
      }

      // ── Model D2: Normalized miss penalty ─────────────────────────────────
      // miss_rate = count_miss / (count_circles + count_sliders)
      // speed_miss_penalty     = exp(-8  × miss_rate)   [more tolerant]
      // acc/stam/ln_miss_penalty = exp(-15 × miss_rate)  [precision-sensitive]
      const missRate          = misses / totalObjects;
      const speedMissPenalty  = Math.exp(-8  * missRate);
      const qualMissPenalty   = Math.exp(-15 * missRate);

      // 1. SPEED (Per-play)
      const speedRaw = starRating * (1 + noteDensity / 25.0) * accuracy * speedMissPenalty;
      speedValues.push({ value: speedRaw, weight: ppWeight });

      // 2. ACCURACY (Per-play)
      const countGeki = Number(score.statistics?.count_geki) || 0;
      const count300  = Number(score.statistics?.count_300) || 0;
      const countKatu = Number(score.statistics?.count_katu) || 0; // 200/100g
      const count100  = Number(score.statistics?.count_100) || 0;
      const count50   = Number(score.statistics?.count_50) || 0;
      const timingDenom = countGeki + count300 + countKatu + count100 + count50;

      if (timingDenom > 0) {
        const maxRatio = countGeki / timingDenom;
        const accuracyBase = 0.65 * maxRatio + 0.35 * accuracy;
        const difficultyFactor = 0.85 + 0.15 * Math.min(10, starRating) / 10;
        const accuracyRaw = accuracyBase * difficultyFactor * qualMissPenalty;
        accuracyValues.push({ value: accuracyRaw, weight: ppWeight });
      }

      // 3. STAMINA (Per-play)
      const durationFactor = 1 - Math.exp(-effHitLen / 120.0);
      const staminaRaw = noteDensity * durationFactor * Math.min(10, starRating) * Math.pow(accuracy, 2) * qualMissPenalty;
      staminaRawValues.push(staminaRaw);

      // 4. LN CONTROL (Per-play)
      const lnRaw = lnRatio * Math.min(10, starRating) * Math.pow(accuracy, 2) * qualMissPenalty;
      lnRawValues.push(lnRaw);
    }

    const speedRawAvg = weightedAverage(speedValues);
    const accuracyRawAvg = weightedAverage(accuracyValues);

    // Top 5 Stamina Aggregation
    staminaRawValues.sort((a, b) => b - a);
    const top5Stamina = staminaRawValues.slice(0, 5);
    let stamSum = 0, stamW = 0;
    top5Stamina.forEach((val, j) => {
      const w = Math.pow(0.90, j);
      stamSum += val * w;
      stamW += w;
    });
    const staminaRawWeighted = stamW > 0 ? stamSum / stamW : 0;

    // Top 5 LN Aggregation & Exposure Confidence
    lnRawValues.sort((a, b) => b - a);
    const top5LN = lnRawValues.slice(0, 5);
    let lnSum = 0, lnW = 0;
    top5LN.forEach((val, j) => {
      const w = Math.pow(0.90, j);
      lnSum += val * w;
      lnW += w;
    });
    const lnRawWeighted = lnW > 0 ? lnSum / lnW : 0;
    const confidenceLN = Math.min(1.0, lnHeavyCount / 5.0);

    const scaleRating = (raw, smax, exp = 0.8) => {
      if (raw === null || raw === undefined) return null;
      const val = clamp(10 * Math.pow(raw / smax, exp), 0, 10);
      return Number(val.toFixed(1));
    };

    // ── Model D2 Smax constants (recalibrated alongside normalized miss penalty)
    const rawLNRating = scaleRating(lnRawWeighted, 6.0, 0.8) ?? 0;
    const finalLNRating = Number(clamp(rawLNRating * confidenceLN, 0, 10).toFixed(1));

    return {
      speed: scaleRating(speedRawAvg, 22.0, 0.8),
      accuracy: scaleRating(accuracyRawAvg, 0.80, 0.8),
      stamina: scaleRating(staminaRawWeighted, 260.0, 0.8),
      ln_control: finalLNRating,
    };
  }

  // ── osu!catch (fruits) ───────────────────────────────────────────────────
  if (mode === 'fruits') {
    const movementRawValues = [];
    const accuracyRawValues = [];
    let fullConfidenceCount = 0;

    for (const entry of entries) {
      const score = entry.score;
      const beatmap = entry.beatmap;
      const attr = entry.attributes;

      const accuracy = Number(score.accuracy) || 0; // decimal 0.0 to 1.0
      const misses   = Number(score.statistics?.count_miss) || 0;
      const starRating = Number(attr.star_rating) || Number(beatmap.difficulty_rating) || 0;

      const circles = Number(beatmap.count_circles) || 0;
      const sliders = Number(beatmap.count_sliders) || 0;
      const totalObjects = Number(beatmap.count_spinners) > 0 
        ? circles + sliders + Number(beatmap.count_spinners) 
        : circles + sliders;
      const effObjects = totalObjects > 0 ? totalObjects : (Number(score.statistics?.count_300) || 1);
      const missRate = misses / effObjects;

      // ── Movement Raw ──────────────────────────────────────────────────────
      const rawFeat = entry.rawMovementFeatures;
      let movementRaw = 0;
      if (rawFeat && typeof rawFeat.vP95 === 'number') {
        fullConfidenceCount++;
        movementRaw = rawFeat.vP95 * (1 + 0.15 * rawFeat.hyperdashRatio) * accuracy * Math.exp(-5 * missRate);
      } else {
        // Fallback: REDUCED confidence (SR * 0.225 aligns 10.0* SR with average full spatial velocity ~2.25 px/ms)
        movementRaw = (starRating * 0.225) * accuracy * Math.exp(-5 * missRate);
      }
      movementRawValues.push(movementRaw);

      // ── Accuracy Raw ──────────────────────────────────────────────────────
      const c300 = Number(score.statistics?.count_300) || 0;
      const c100 = Number(score.statistics?.count_100) || 0;
      const c50  = Number(score.statistics?.count_50) || 0;
      const cKatu= Number(score.statistics?.count_katu) || 0;

      const denom = c300 + c100 + c50 + cKatu + misses;
      const dropletQuality = denom > 0 ? (c300 + c100 + c50) / denom : accuracy;
      const accuracyBase = 0.70 * dropletQuality + 0.30 * accuracy;
      const difficultyFactor = 0.85 + 0.15 * Math.min(10, starRating) / 10;
      const accuracyRaw = accuracyBase * difficultyFactor * Math.exp(-15 * missRate);

      accuracyRawValues.push(accuracyRaw);
    }

    // Top 5 Movement Aggregation (Decay 0.90^j)
    movementRawValues.sort((a, b) => b - a);
    const top5Movement = movementRawValues.slice(0, 5);
    let movSum = 0, movW = 0;
    top5Movement.forEach((val, j) => {
      const w = Math.pow(0.90, j);
      movSum += val * w;
      movW += w;
    });
    const movementRawWeighted = movW > 0 ? movSum / movW : 0;

    // Top 5 Accuracy Aggregation (Decay 0.90^j)
    accuracyRawValues.sort((a, b) => b - a);
    const top5Acc = accuracyRawValues.slice(0, 5);
    let accSum = 0, accW = 0;
    top5Acc.forEach((val, j) => {
      const w = Math.pow(0.90, j);
      accSum += val * w;
      accW += w;
    });
    const accuracyRawWeighted = accW > 0 ? accSum / accW : 0;

    const scaleRating = (raw, smax, exp = 0.8) => {
      if (raw === null || raw === undefined) return null;
      const val = clamp(10 * Math.pow(raw / smax, exp), 0, 10);
      return Number(val.toFixed(1));
    };

    const confidence = fullConfidenceCount >= 3 ? 'FULL' : 'REDUCED';

    return {
      movement: scaleRating(movementRawWeighted, 3.50, 0.85),
      accuracy: scaleRating(accuracyRawWeighted, 1.00, 1.00),
      movement_confidence: confidence,
    };
  }

  // ── osu!taiko ─────────────────────────────────────────────────────────────
  if (mode === 'taiko') {
    const readingRawValues   = [];
    const speedRawValues     = [];
    const staminaRawValues   = [];
    const technicalRawValues = [];
    let fullConfidenceCount  = 0;

    for (const entry of entries) {
      const score   = entry.score;
      const beatmap = entry.beatmap;
      const attr    = entry.attributes;

      const accuracy   = Number(score.accuracy) || 0; // decimal 0.0 to 1.0
      const misses     = Number(score.statistics?.count_miss) || 0;
      const starRating = Number(attr.star_rating) || Number(beatmap.difficulty_rating) || 0;

      const circles      = Number(beatmap.count_circles) || 0;
      const sliders      = Number(beatmap.count_sliders) || 0;
      const spinners     = Number(beatmap.count_spinners) || 0;
      const totalObjects = circles + sliders + spinners;
      const effObjects   = totalObjects > 0 ? totalObjects : ((Number(score.statistics?.count_300) || 0) + (Number(score.statistics?.count_100) || 0) + misses) || 1;
      const missRate     = misses / effObjects;

      const rawFeat = entry.rawTaikoFeatures;

      if (rawFeat && typeof rawFeat.p95Freq === 'number') {
        fullConfidenceCount++;

        // 1. READING
        const readingRaw = (2.0 * rawFeat.rhythmTransitionRate + 0.4 * Math.min(3.0, rawFeat.intervalCV)) *
          (0.85 + 0.15 * Math.min(10, starRating) / 10) * accuracy * Math.exp(-10 * missRate);
        readingRawValues.push(readingRaw);

        // 2. SPEED
        const speedRaw = (rawFeat.p95Freq / 2.5) * (1 + 0.20 * rawFeat.fastIntervalRatio) * accuracy * Math.exp(-8 * missRate);
        speedRawValues.push(speedRaw);

        // 3. STAMINA
        const staminaRaw = (0.50 * rawFeat.totalStreamSec + 2.00 * rawFeat.longestStreamSec) * Math.pow(accuracy, 2) * Math.exp(-15 * missRate);
        staminaRawValues.push(staminaRaw);

        // 4. TECHNICAL
        const technicalRaw = (1.50 * rawFeat.fastSwitchRate + 1.20 * rawFeat.complexPatternRatio + 0.80 * rawFeat.normH4) * accuracy * Math.exp(-15 * missRate);
        technicalRawValues.push(technicalRaw);
      } else {
        // Fallback: REDUCED confidence
        const readingFallback = 1.20 * (0.85 + 0.15 * Math.min(10, starRating) / 10) * accuracy * Math.exp(-10 * missRate);
        const speedFallback = (starRating * 1.25) * accuracy * Math.exp(-8 * missRate);
        const staminaFallback = (circles * 0.08) * Math.pow(accuracy, 2) * Math.exp(-15 * missRate);
        const technicalFallback = 2.20 * accuracy * Math.exp(-15 * missRate);

        readingRawValues.push(readingFallback);
        speedRawValues.push(speedFallback);
        staminaRawValues.push(staminaFallback);
        technicalRawValues.push(technicalFallback);
      }
    }

    // Top 5 Aggregation with 0.90^j decay
    const aggregateTop5 = (vals) => {
      vals.sort((a, b) => b - a);
      const top5 = vals.slice(0, 5);
      let sum = 0, wSum = 0;
      top5.forEach((val, j) => {
        const w = Math.pow(0.90, j);
        sum += val * w;
        wSum += w;
      });
      return wSum > 0 ? sum / wSum : 0;
    };

    const rWeighted  = aggregateTop5(readingRawValues);
    const sWeighted  = aggregateTop5(speedRawValues);
    const stWeighted = aggregateTop5(staminaRawValues);
    const tWeighted  = aggregateTop5(technicalRawValues);

    const scaleRating = (raw, smax, exp = 0.85) => {
      if (raw === null || raw === undefined) return null;
      const val = clamp(10 * Math.pow(raw / smax, exp), 0, 10);
      return Number(val.toFixed(1));
    };

    const confidence = fullConfidenceCount >= 3 ? 'FULL' : 'REDUCED';

    return {
      reading: scaleRating(rWeighted, 2.00, 0.85),
      speed: scaleRating(sWeighted, 12.00, 0.85),
      stamina: scaleRating(stWeighted, 160.0, 0.80),
      technical: scaleRating(tWeighted, 3.20, 0.85),
      taiko_confidence: confidence,
    };
  }

  return null;
}

// ─── Performance Profile Cache & Pipeline Parameters ─────────────────────────
//
// In-memory cache keyed by "username:mode:version".
// Only derived performance data is stored — no tokens or credentials.
//
const PERF_CACHE_TTL_MS     = 10 * 60 * 1000; // 10 minutes
const CANDIDATE_LIMIT       = 100;            // Candidate pool size from osu! API
const BATCH_SIZE            = 4;              // Bounded concurrency per batch
const BATCH_DELAY_MS        = 40;             // Delay between network-heavy batches (ms)
const MIN_VALID_SCORES      = 3;              // Minimum valid plays required to compute profile

// Adaptive deep-analysis limit per ruleset (uncached network target)
const DEEP_ANALYSIS_LIMIT_BY_MODE = {
  osu:    40, // Standard: attributes only (pure JSON, fast)
  mania:  40, // Mania: attributes only (pure JSON, fast)
  fruits: 30, // Catch: attributes + raw .osu geometry
  taiko:  30, // Taiko: attributes + raw .osu hit-object patterns
};

function getDeepAnalysisLimit(mode) {
  return DEEP_ANALYSIS_LIMIT_BY_MODE[mode] ?? 30;
}

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

/**
 * Deterministic candidate triage:
 * Selects up to deepLimit uncached plays prioritizing top PP,
 * difficulty relevance, and beatmap uniqueness, while including all already-cached
 * candidate plays at zero network cost.
 */
function triageCandidates(scores, mode) {
  const deepLimit = getDeepAnalysisLimit(mode);
  if (!Array.isArray(scores) || scores.length <= deepLimit) {
    return scores || [];
  }

  const fullyCached = [];
  const uncached = [];

  for (const s of scores) {
    const bId = s.beatmap?.id ?? s.beatmap_id;
    const mods = Array.isArray(s.mods)
      ? s.mods.map(m => (typeof m === 'string' ? m : m.acronym))
      : [];
    const modStr = mods.sort().join(',');
    const attrKey = `${bId}_${mode}_${modStr}`;
    const isAttrCached = attrCache.has(attrKey);

    let isRawCached = true;
    if (mode === 'fruits') {
      isRawCached = rawOsuCache.has(bId);
    } else if (mode === 'taiko') {
      const isDT = mods.includes('DT') || mods.includes('NC');
      const isHT = mods.includes('HT');
      const rate = isDT ? 1.5 : isHT ? 0.75 : 1.0;
      isRawCached = rawTaikoCache.has(`${bId}_rate${rate}`);
    }

    if (isAttrCached && isRawCached) {
      fullyCached.push(s);
    } else {
      uncached.push(s);
    }
  }

  // Triage Strategy: Top 20 PP with unique beatmaps + highest SR from remainder
  const selectedUncached = [];
  const seenMapIds = new Set();

  // Primary: Top PP plays
  for (const s of uncached) {
    const bId = s.beatmap?.id ?? s.beatmap_id;
    if (!seenMapIds.has(bId)) {
      seenMapIds.add(bId);
      selectedUncached.push(s);
      if (selectedUncached.length >= 20) break;
    }
  }

  // Secondary: Highest difficulty rating from remaining uncached
  const remainderUncached = uncached.filter(s => !selectedUncached.includes(s));
  remainderUncached.sort(
    (a, b) => (Number(b.beatmap?.difficulty_rating) || 0) - (Number(a.beatmap?.difficulty_rating) || 0)
  );

  for (const s of remainderUncached) {
    if (selectedUncached.length >= deepLimit) break;
    selectedUncached.push(s);
  }

  // Combine all fully cached candidates + selected uncached candidates
  return Array.from(new Set([...fullyCached, ...selectedUncached]));
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

  // 2. Fetch candidate pool (up to 100 best scores)
  const scoresUrl = new URL(`${OSU_API_BASE}/users/${user.id}/scores/best`);
  scoresUrl.searchParams.set('mode', mode);
  scoresUrl.searchParams.set('limit', String(CANDIDATE_LIMIT));
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
    return {
      mode,
      candidate_count: 0,
      sample_size: 0,
      cached: false,
      metrics: null,
      message: 'No best scores available for this player.',
    };
  }

  // 3. Triage candidate plays for deep analysis
  const candidatesToAnalyze = triageCandidates(scores, mode);

  // 4. Perform bounded deep analysis in controlled batches
  const analyzed = [];
  for (let i = 0; i < candidatesToAnalyze.length; i += BATCH_SIZE) {
    const batch = candidatesToAnalyze.slice(i, i + BATCH_SIZE);
    let hadNetworkFetch = false;

    const batchResults = await Promise.all(
      batch.map(async (score) => {
        const beatmapId = score.beatmap?.id ?? score.beatmap_id;
        if (!beatmapId) return null;

        const mods = Array.isArray(score.mods)
          ? score.mods.map(m => (typeof m === 'string' ? m : m.acronym))
          : [];
        const modStr = mods.sort().join(',');
        const attrKey = `${beatmapId}_${mode}_${modStr}`;

        if (!attrCache.has(attrKey)) hadNetworkFetch = true;

        const attr = await fetchBeatmapAttributes(beatmapId, mode, score.mods || [], token);
        let rawMovementFeatures = null;
        let rawTaikoFeatures = null;

        if (mode === 'fruits') {
          if (!rawOsuCache.has(beatmapId)) hadNetworkFetch = true;
          const cs = Number(score.beatmap?.cs) || 5.0;
          rawMovementFeatures = await getRawOsuMovementFeatures(beatmapId, cs);
        } else if (mode === 'taiko') {
          const isDT = mods.includes('DT') || mods.includes('NC');
          const isHT = mods.includes('HT');
          const rate = isDT ? 1.5 : isHT ? 0.75 : 1.0;
          if (!rawTaikoCache.has(`${beatmapId}_rate${rate}`)) hadNetworkFetch = true;
          rawTaikoFeatures = await getRawOsuTaikoFeatures(beatmapId, rate);
        }

        return {
          score,
          beatmap: score.beatmap || {},
          attributes: attr || {},
          rawMovementFeatures,
          rawTaikoFeatures,
        };
      })
    );

    analyzed.push(...batchResults);

    // Apply brief pacing delay if any network request was issued in this batch
    if (hadNetworkFetch && i + BATCH_SIZE < candidatesToAnalyze.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const validScores = analyzed.filter(Boolean);

  if (validScores.length < MIN_VALID_SCORES) {
    return {
      mode,
      candidate_count: scores.length,
      sample_size: validScores.length,
      cached: false,
      metrics: null,
      message: 'Not enough score data to calculate a reliable performance profile.',
    };
  }

  // 5. Derive BeatCard metrics
  const metrics = calculatePerformanceProfile(validScores, mode);
  return {
    mode,
    candidate_count: scores.length,
    sample_size: validScores.length,
    cached: false,
    metrics,
  };
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
 * Supported modes: osu (Standard), mania (osu!mania), fruits (osu!catch), taiko (osu!taiko).
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

  // Only osu standard, mania, fruits, and taiko are implemented
  if (mode !== 'osu' && mode !== 'mania' && mode !== 'fruits' && mode !== 'taiko') {
    return res.status(501).json({
      error: 'MODE_NOT_IMPLEMENTED',
      message: `Performance profile for "${mode}" mode is not yet implemented. Only "osu" (osu! Standard), "mania" (osu!mania), "fruits" (osu!catch), and "taiko" (osu!taiko) are currently supported.`,
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
  const cacheVersion = `v2_pool_${mode}`;
  const cacheKey = `${username}:${mode}:${cacheVersion}`;

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
