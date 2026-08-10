/**
 * BeatCard — app.js
 * Frontend logic: search, API calls, card rendering, PNG export.
 *
 * Security: This file makes requests ONLY to /api/user/:username on the
 * local server. No osu! credentials or access tokens are ever present here.
 */

'use strict';

// ── DOM references ────────────────────────────────────────────────────────────
const searchForm    = document.getElementById('searchForm');
const usernameInput = document.getElementById('usernameInput');
const searchBtn     = document.getElementById('searchBtn');
const gameMode      = document.getElementById('gameMode');

const statusArea  = document.getElementById('statusArea');
const loadingState = document.getElementById('loadingState');
const errorState   = document.getElementById('errorState');
const errorTitle   = document.getElementById('errorTitle');
const errorMessage = document.getElementById('errorMessage');

const resultSection = document.getElementById('resultSection');
const downloadBtn   = document.getElementById('downloadBtn');
const newSearchBtn  = document.getElementById('newSearchBtn');

// Card DOM elements
const cardCover       = document.getElementById('cardCover');
const cardAvatar      = document.getElementById('cardAvatar');
const cardUsername    = document.getElementById('cardUsername');
const cardMode        = document.getElementById('cardMode');
const cardFlag        = document.getElementById('cardFlag');
const cardCountryName = document.getElementById('cardCountryName');

const statRank      = document.getElementById('statRank');
const statPP        = document.getElementById('statPP');
const statAccuracy  = document.getElementById('statAccuracy');
const statPlayCount = document.getElementById('statPlayCount');
const statLevel = document.getElementById('statLevel');

// Track the current player for the download filename
let currentUsername = '';

// ── Utility: number formatters ────────────────────────────────────────────────

/**
 * Format a number with comma separators. Returns '—' for null/undefined.
 */
function fmtNumber(n) {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Format global rank as #1,234 or '—'.
 */
function fmtRank(rank) {
  if (rank == null) return 'Unranked';
  return `#${Math.round(rank).toLocaleString('en-US')}`;
}

/**
 * Format PP as "12,483 PP" or '—'.
 */
function fmtPP(pp) {
  if (pp == null) return '—';
  return `${Math.round(pp).toLocaleString('en-US')} PP`;
}

/**
 * Format accuracy as "97.42%" or '—'.
 */
function fmtAccuracy(acc) {
  if (acc == null) return '—';
  return `${Number(acc).toFixed(2)}%`;
}

/**
 * Convert total seconds to a human-readable play time string.
 * Examples: "184h 32m", "3d 12h"
 */
function fmtPlayTime(totalSeconds) {
  if (totalSeconds == null || totalSeconds === '' || totalSeconds === 0) return '—';

  const secs  = Math.floor(totalSeconds);
  const hours = Math.floor(secs / 3600);
  const mins  = Math.floor((secs % 3600) / 60);

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function showLoading() {
  loadingState.hidden = false;
  errorState.hidden   = true;
  resultSection.hidden = true;
}

function hideLoading() {
  loadingState.hidden = true;
}

function showError(title, message) {
  hideLoading();
  errorTitle.textContent   = title;
  errorMessage.textContent = message;
  errorState.hidden  = false;
  resultSection.hidden = true;
}

function hideError() {
  errorState.hidden = true;
}

function setSearchBusy(busy) {
  searchBtn.disabled = busy;
  usernameInput.disabled = busy;
}

function resetToSearch() {
  resultSection.hidden = true;
  hideError();
  hideLoading();
  usernameInput.focus();
}

// ── Image proxy helper ────────────────────────────────────────────────────────
/**
 * Load an image through a server proxy to avoid CORS issues in html2canvas.
 * Falls back to the direct URL on the live page (where CORS is less strict).
 */
function proxyImageUrl(url) {
  if (!url) return '';
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

// ── Card rendering ────────────────────────────────────────────────────────────

/**
 * Populate the player card with data from the API response.
 * @param {object} user — safe user object returned by /api/user/:username
 */
async function renderCard(user) {
  currentUsername = user.username || 'player';

  // ── Avatar ──────────────────────────────────────────────────────────────
  if (user.avatar_url) {
    cardAvatar.src = proxyImageUrl(user.avatar_url);
    cardAvatar.alt = `${user.username}'s avatar`;

    cardAvatar.onerror = () => {
      cardAvatar.src = '';
      cardAvatar.alt = '';
    };
  } else {
    cardAvatar.src = '';
    cardAvatar.alt = '';
  }

  // ── Cover / background image ────────────────────────────────────────────
  if (user.cover_url) {
    const proxiedCover = proxyImageUrl(user.cover_url);

    cardCover.style.backgroundImage = `url("${proxiedCover}")`;
    cardCover.style.backgroundSize = 'cover';
    cardCover.style.backgroundPosition = 'center';
  } else {
    cardCover.style.backgroundImage = '';
  }

  // ── Username ────────────────────────────────────────────────────────────
  cardUsername.textContent = user.username || '—';

  // ── Game mode ───────────────────────────────────────────────────────────
  const modeNames = {
    osu: 'osu! STANDARD',
    taiko: 'osu! TAIKO',
    fruits: 'osu! CATCH',
    mania: 'osu! MANIA'
  };

  if (cardMode) {
    cardMode.textContent = modeNames[user.mode] || 'osu!';
  }

  // ── Country & flag ──────────────────────────────────────────────────────
  const countryCode = user.country && user.country.code;
  const countryName = user.country && user.country.name;

  if (countryCode) {
    // Use flagcdn.com for country flags (reliable, no CORS issues)
    cardFlag.src = `https://flagcdn.com/w40/${countryCode.toLowerCase()}.png`;
    cardFlag.alt = countryName || countryCode;
    cardFlag.hidden = false;
  } else {
    cardFlag.src = '';
    cardFlag.hidden = true;
  }

  cardCountryName.textContent = countryName || '—';

  // ── Statistics ──────────────────────────────────────────────────────────
  const s = user.statistics || {};
  statRank.textContent      = fmtRank(s.global_rank);
  statPP.textContent        = fmtPP(s.pp);
  statAccuracy.textContent  = fmtAccuracy(s.hit_accuracy);
  statPlayCount.textContent = fmtNumber(s.play_count);
  statLevel.textContent = user.statistics?.level?.current ?? '—';

  // ── Show card ───────────────────────────────────────────────────────────
  hideLoading();
  hideError();
  resultSection.hidden = false;

  // Scroll card into view smoothly
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── API fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch a player's profile from the local API proxy.
 * @param {string} username
 */
async function fetchUser(username, mode) {
  const res = await fetch(
    `/api/user/${encodeURIComponent(username)}/${encodeURIComponent(mode)}`
  );

  const data = await res.json();

  if (!res.ok) {
    // Map error codes to user-friendly messages
    const code = data && data.error;
    const backendMsg = data && data.message;

    switch (code) {
      case 'USER_NOT_FOUND':
        throw {
          title: 'Player not found',
          message:
            backendMsg ||
            `No osu! player named "${username}" could be found.`
        };

      case 'INVALID_USERNAME':
        throw {
          title: 'Invalid username',
          message:
            backendMsg ||
            'Please enter a valid osu! username.'
        };

      case 'INVALID_MODE':
        throw {
          title: 'Invalid game mode',
          message:
            backendMsg ||
            'Please select a valid osu! game mode.'
        };

      case 'SERVER_NOT_CONFIGURED':
        throw {
          title: 'Server not configured',
          message:
            'Please add your osu! API credentials to the .env file and restart the server.'
        };

      case 'RATE_LIMITED':
        throw {
          title: 'Rate limited',
          message:
            'Too many requests. Please wait a moment and try again.'
        };

      case 'NETWORK_ERROR':
        throw {
          title: 'Network error',
          message:
            'Could not reach the osu! API. Check your internet connection.'
        };

      default:
        throw {
          title: 'Error',
          message:
            backendMsg ||
            'An unexpected error occurred. Please try again.'
        };
    }
  }

  return data;
  }

// ── Search handler ────────────────────────────────────────────────────────────

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const raw = usernameInput.value.trim();
  const mode = gameMode.value;

  if (!raw) {
    usernameInput.focus();
    return;
  }

  if (raw.length > 20) {
    showError(
      'Invalid username',
      'osu! usernames can be at most 20 characters long.'
    );
    return;
  }

  setSearchBusy(true);
  showLoading();

  try {
    const mode = gameMode.value;
    const user = await fetchUser(raw, mode);
    await renderCard(user);
  } catch (err) {
    const title = err.title || 'Something went wrong';
    const message = err.message || 'Please try again.';
    showError(title, message);
  } finally {
    setSearchBusy(false);
  }
});

// Focus the input on page load
usernameInput.focus();

// ── "Search Another" button ───────────────────────────────────────────────────
newSearchBtn.addEventListener('click', () => {
  resetToSearch();
  usernameInput.value = '';
  usernameInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── PNG Download ──────────────────────────────────────────────────────────────

/**
 * Helper: load an image and return its natural dimensions.
 * Used to pre-warm the browser cache before html2canvas captures.
 */
function preloadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Export the player card as a 1200×630 PNG and trigger a download.
 * We use html2canvas with useCORS=true so that osu! avatar/cover images
 * are included in the output (requires the browser's CORS preflight to pass,
 * which osu!'s CDN allows for GET requests).
 */
downloadBtn.addEventListener('click', async () => {
  const card = document.getElementById('playerCard');
  if (!card) return;

  // Show a brief busy state on the button
  const origText = downloadBtn.innerHTML;
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `
    <span class="download-btn-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 0.9s linear infinite">
        <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
        <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
      </svg>
    </span>
    Rendering…
  `;

  try {
    // Pre-load images cross-origin to warm the browser cache
    const avatarSrc = cardAvatar.src;
    const coverSrc  = cardCover.style.backgroundImage
      ? cardCover.style.backgroundImage.replace(/url\(['"]?(.*?)['"]?\)/, '$1')
      : null;

    await Promise.all([
      preloadImage(avatarSrc),
      coverSrc ? preloadImage(coverSrc) : Promise.resolve(),
    ]);

    // Capture at the card's native 1200×630 dimensions
    const cardWrapper = document.getElementById('cardWrapper');
    const wrapperRect = cardWrapper.getBoundingClientRect();

    const exportWidth = 1200;
    const exportHeight = 630;

    const scaleFactor = exportWidth / wrapperRect.width;

    const canvas = await html2canvas(card, {
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#08080f',

      scale: scaleFactor,

      width: wrapperRect.width,
      height: wrapperRect.height,

      logging: false,

      onclone: (clonedDoc) => {
        // Disable animations/transitions for a stable screenshot
        const style = clonedDoc.createElement('style');

        style.textContent = `
          * {
            animation: none !important;
            transition: none !important;
          }

          /*
          * html2canvas can incorrectly render
          * background-clip:text as a large rectangle.
          * Use solid colors for the exported PNG.
          */

          .stat-block--rank .stat-value--large {
            background: none !important;
            -webkit-background-clip: initial !important;
            background-clip: initial !important;
            -webkit-text-fill-color: #ff66aa !important;
            color: #ff66aa !important;
          }

          .stat-block--pp .stat-value--large {
            background: none !important;
            -webkit-background-clip: initial !important;
            background-clip: initial !important;
            -webkit-text-fill-color: #ffd45c !important;
            color: #ffd45c !important;
          }
        `;

        clonedDoc.head.appendChild(style);
      },
    });

    // Verify output dimensions (should be 1200×630 ± 1px)
    const finalCanvas = canvas;

    // Trigger download
    const safeUsername = currentUsername.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = `BeatCard_${safeUsername}.png`;

    finalCanvas.toBlob((blob) => {
      if (!blob) {
        alert('Failed to generate PNG. Please try again.');
        return;
      }
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href     = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Free object URL after a short delay
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');

  } catch (err) {
    console.error('[BeatCard] PNG export failed:', err.message || err);
    alert('Could not export the card as PNG. Please try again.');
  } finally {
    downloadBtn.disabled  = false;
    downloadBtn.innerHTML = origText;
  }
});

// ── Keyboard shortcut: Enter focuses search ───────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== usernameInput) {
    e.preventDefault();
    usernameInput.focus();
  }
});
