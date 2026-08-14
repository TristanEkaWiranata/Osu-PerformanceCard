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
const viewProfileBtn = document.getElementById('viewProfileBtn');

// Profile confirmation modal DOM elements
const profileConfirmModal   = document.getElementById('profileConfirmModal');
const profileConfirmCloseX = document.getElementById('profileConfirmCloseX');
const confirmUsername       = document.getElementById('confirmUsername');
const confirmModeName       = document.getElementById('confirmModeName');
const confirmCancelBtn      = document.getElementById('confirmCancelBtn');
const confirmVisitBtn       = document.getElementById('confirmVisitBtn');

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

// Performance Profile DOM references
const perfProfileContainer = document.getElementById('perfProfileContainer');
const perfLoading          = document.getElementById('perfLoading');
const perfError            = document.getElementById('perfError');
const perfRetryBtn         = document.getElementById('perfRetryBtn');
const perfContent          = document.getElementById('perfContent');

const perfValAim           = document.getElementById('perfValAim');
const perfValSpeed         = document.getElementById('perfValSpeed');
const perfValAccuracy      = document.getElementById('perfValAccuracy');
const perfValStamina       = document.getElementById('perfValStamina');

const perfBarAim           = document.getElementById('perfBarAim');
const perfBarSpeed         = document.getElementById('perfBarSpeed');
const perfBarAccuracy      = document.getElementById('perfBarAccuracy');
const perfBarStamina       = document.getElementById('perfBarStamina');

const perfSampleSize       = document.getElementById('perfSampleSize');

// Track the current player for the download filename and retries
let currentUsername      = '';
let currentMode          = 'osu';
let lastSearchedUsername = '';
let lastSearchedMode     = '';
let pendingProfileUrl    = '#';

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

/**
 * Safely build the official osu! profile URL for a user and mode.
 * @param {string} username
 * @param {string} mode
 */
function buildOsuProfileUrl(username, mode) {
  if (!username) return '#';
  const safeUser = encodeURIComponent(username);
  const safeMode = mode === 'mania' ? 'mania' : mode === 'fruits' ? 'fruits' : mode === 'taiko' ? 'taiko' : 'osu';
  return `https://osu.ppy.sh/users/${safeUser}/${safeMode}`;
}

/**
 * Clear the View Profile button link state during loading, error, or search resets.
 */
function clearViewProfileUrl() {
  if (viewProfileBtn) {
    viewProfileBtn.href = '#';
    viewProfileBtn.removeAttribute('aria-label');
  }
}

function showLoading() {
  clearViewProfileUrl();
  loadingState.hidden = false;
  errorState.hidden   = true;
  resultSection.hidden = true;
}

function hideLoading() {
  loadingState.hidden = true;
}

function showError(title, message) {
  clearViewProfileUrl();
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
  clearViewProfileUrl();
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
  currentMode     = user.mode || 'osu';

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

  // ── View Profile URL ───────────────────────────────────────────────────
  if (viewProfileBtn) {
    const profileUrl = buildOsuProfileUrl(user.username, user.mode);
    viewProfileBtn.href = profileUrl;
    viewProfileBtn.setAttribute('aria-label', `View ${user.username}'s osu! profile`);
  }

  // ── Show card ───────────────────────────────────────────────────────────
  hideLoading();
  hideError();
  resultSection.hidden = false;

  // Scroll card into view smoothly
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Trigger performance profile load independently after player card renders
  loadPerformanceProfile(user.username, user.mode);
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
      ? cardCover.style.backgroundImage.replace(/url\(['"']?(.*?)['"']?\)/, '$1')
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

// ─── Performance Profile Logic ───────────────────────────────────────────────

/**
 * Fetch performance metrics from the server.
 * Returns null if the mode is not implemented (501).
 */
async function fetchPerformance(username, mode) {
  const url = `/api/user/${encodeURIComponent(username)}/${encodeURIComponent(mode)}/performance`;
  const res = await fetch(url);
  
  if (res.status === 501) {
    return null; // Not implemented for this mode - hide performance section silently
  }
  
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Could not fetch performance data.');
  }
  
  return data;
}

/**
 * Populate performance UI with the metrics and update progress bars.
 */
function renderPerformanceProfile(data) {
  if (!data || !data.metrics) {
    const errorText = perfError.querySelector('.perf-error-text');
    if (errorText) {
      errorText.textContent = data?.message || 'Performance Profile unavailable';
    }
    perfLoading.hidden = true;
    perfContent.hidden = true;
    perfError.hidden   = false;
    return;
  }

  const m = data.metrics;
  const isMania = data.mode === 'mania';
  const isFruits = data.mode === 'fruits';
  const isTaiko = data.mode === 'taiko';

  const card1 = document.querySelector('.perf-grid > div:nth-child(1)');
  const card2 = document.querySelector('.perf-grid > div:nth-child(2)');
  const card3 = document.querySelector('.perf-grid > div:nth-child(3)');
  const card4 = document.querySelector('.perf-grid > div:nth-child(4)');

  const fmtPoints = (pts) => {
    if (pts == null || Number.isNaN(Number(pts))) return '0 pts';
    return `${Math.round(Number(pts)).toLocaleString('en-US')} pts`;
  };

  const calcBarWidth = (pts) => {
    const p = Number(pts) || 0;
    if (p <= 0) return 0;
    if (p <= 1000) {
      return Math.max(0, Math.min(100, 70 * (p / 1000)));
    } else {
      const excess = p - 1000;
      const w = 70 + 30 * (1 - Math.exp(-excess / 600));
      return Math.max(0, Math.min(100, w));
    }
  };

  if (isFruits) {
    // Fruits (osu!catch) Layout: MOVEMENT, ACCURACY (2 cards only)
    if (card1) {
      card1.style.display = '';
      card1.className = 'perf-card perf-card--movement';
      const nameEl = card1.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'MOVEMENT';
      const barEl = card1.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--movement';
    }
    if (card2) {
      card2.style.display = '';
      card2.className = 'perf-card perf-card--accuracy';
      const nameEl = card2.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'ACCURACY';
      const barEl = card2.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--accuracy';
    }
    if (card3) card3.style.display = 'none';
    if (card4) card4.style.display = 'none';

    perfValAim.textContent   = fmtPoints(m.movement);
    perfValSpeed.textContent = fmtPoints(m.accuracy);

    setTimeout(() => {
      perfBarAim.style.width   = `${calcBarWidth(m.movement)}%`;
      perfBarSpeed.style.width = `${calcBarWidth(m.accuracy)}%`;
    }, 50);

  } else if (isTaiko) {
    if (card1) card1.style.display = '';
    if (card2) card2.style.display = '';
    if (card3) card3.style.display = '';
    if (card4) card4.style.display = '';

    // Taiko Layout: READING, SPEED, STAMINA, TECHNICAL
    if (card1) {
      card1.className = 'perf-card perf-card--reading';
      const nameEl = card1.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'READING';
      const barEl = card1.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--reading';
    }
    if (card2) {
      card2.className = 'perf-card perf-card--speed';
      const nameEl = card2.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'SPEED';
      const barEl = card2.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--speed';
    }
    if (card3) {
      card3.className = 'perf-card perf-card--stamina';
      const nameEl = card3.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'STAMINA';
      const barEl = card3.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--stamina';
    }
    if (card4) {
      card4.className = 'perf-card perf-card--technical';
      const nameEl = card4.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'TECHNICAL';
      const barEl = card4.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--technical';
    }

    perfValAim.textContent      = fmtPoints(m.reading);
    perfValSpeed.textContent    = fmtPoints(m.speed);
    perfValAccuracy.textContent = fmtPoints(m.stamina);
    perfValStamina.textContent  = fmtPoints(m.technical);

    setTimeout(() => {
      perfBarAim.style.width      = `${calcBarWidth(m.reading)}%`;
      perfBarSpeed.style.width    = `${calcBarWidth(m.speed)}%`;
      perfBarAccuracy.style.width = `${calcBarWidth(m.stamina)}%`;
      perfBarStamina.style.width  = `${calcBarWidth(m.technical)}%`;
    }, 50);

  } else if (isMania) {
    if (card1) card1.style.display = '';
    if (card2) card2.style.display = '';
    if (card3) card3.style.display = '';
    if (card4) card4.style.display = '';

    // Mania Layout: SPEED, ACCURACY, STAMINA, LN CONTROL
    if (card1) {
      card1.className = 'perf-card perf-card--speed';
      const nameEl = card1.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'SPEED';
      const barEl = card1.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--speed';
    }
    if (card2) {
      card2.className = 'perf-card perf-card--accuracy';
      const nameEl = card2.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'ACCURACY';
      const barEl = card2.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--accuracy';
    }
    if (card3) {
      card3.className = 'perf-card perf-card--stamina';
      const nameEl = card3.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'STAMINA';
      const barEl = card3.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--stamina';
    }
    if (card4) {
      card4.className = 'perf-card perf-card--ln';
      const nameEl = card4.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'LN CONTROL';
      const barEl = card4.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--ln';
    }

    perfValAim.textContent      = fmtPoints(m.speed);
    perfValSpeed.textContent    = fmtPoints(m.accuracy);
    perfValAccuracy.textContent = fmtPoints(m.stamina);
    perfValStamina.textContent  = fmtPoints(m.ln_control);

    setTimeout(() => {
      perfBarAim.style.width      = `${calcBarWidth(m.speed)}%`;
      perfBarSpeed.style.width    = `${calcBarWidth(m.accuracy)}%`;
      perfBarAccuracy.style.width = `${calcBarWidth(m.stamina)}%`;
      perfBarStamina.style.width  = `${calcBarWidth(m.ln_control)}%`;
    }, 50);

  } else {
    if (card1) card1.style.display = '';
    if (card2) card2.style.display = '';
    if (card3) card3.style.display = '';
    if (card4) card4.style.display = '';

    // Standard (osu) Layout: AIM, SPEED, ACCURACY, STAMINA
    if (card1) {
      card1.className = 'perf-card perf-card--aim';
      const nameEl = card1.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'AIM';
      const barEl = card1.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--aim';
    }
    if (card2) {
      card2.className = 'perf-card perf-card--speed';
      const nameEl = card2.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'SPEED';
      const barEl = card2.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--speed';
    }
    if (card3) {
      card3.className = 'perf-card perf-card--accuracy';
      const nameEl = card3.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'ACCURACY';
      const barEl = card3.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--accuracy';
    }
    if (card4) {
      card4.className = 'perf-card perf-card--stamina';
      const nameEl = card4.querySelector('.perf-metric-name');
      if (nameEl) nameEl.textContent = 'STAMINA';
      const barEl = card4.querySelector('.perf-bar-fill');
      if (barEl) barEl.className = 'perf-bar-fill perf-bar-fill--stamina';
    }

    perfValAim.textContent      = fmtPoints(m.aim);
    perfValSpeed.textContent    = fmtPoints(m.speed);
    perfValAccuracy.textContent = fmtPoints(m.accuracy);
    perfValStamina.textContent  = fmtPoints(m.stamina);

    setTimeout(() => {
      perfBarAim.style.width      = `${calcBarWidth(m.aim)}%`;
      perfBarSpeed.style.width    = `${calcBarWidth(m.speed)}%`;
      perfBarAccuracy.style.width = `${calcBarWidth(m.accuracy)}%`;
      perfBarStamina.style.width  = `${calcBarWidth(m.stamina)}%`;
    }, 50);
  }

  // Set sample size text dynamically
  if (data.candidate_count && data.candidate_count > data.sample_size) {
    perfSampleSize.textContent = `Based on ${data.sample_size} analyzed plays (${data.candidate_count} candidates \u00b7 Top 5 weighted)`;
  } else {
    perfSampleSize.textContent = `Based on ${data.sample_size} analyzed plays (Top 5 weighted)`;
  }
  
  perfLoading.hidden = true;
  perfError.hidden   = true;
  perfContent.hidden = false;
}

/**
 * Load the performance profile flow: handle loading, fetch, render, and error states.
 */
async function loadPerformanceProfile(username, mode) {
  lastSearchedUsername = username;
  lastSearchedMode     = mode;

  // Mode gating: currently osu (Standard), mania, fruits, and taiko are supported
  if (mode !== 'osu' && mode !== 'mania' && mode !== 'fruits' && mode !== 'taiko') {
    perfProfileContainer.hidden = true;
    return;
  }

  // Reset display & show loading
  perfProfileContainer.hidden = false;
  perfLoading.hidden          = false;
  perfError.hidden            = true;
  perfContent.hidden          = true;

  // Reset bar widths to 0 so they animate out and back in
  perfBarAim.style.width      = '0%';
  perfBarSpeed.style.width    = '0%';
  perfBarAccuracy.style.width = '0%';
  perfBarStamina.style.width  = '0%';

  try {
    const data = await fetchPerformance(username, mode);
    
    if (data === null) {
      // 501 Mode Not Implemented
      perfProfileContainer.hidden = true;
      return;
    }
    
    renderPerformanceProfile(data);
  } catch (err) {
    console.error('[BeatCard] Performance Profile load failed:', err);
    
    // Set standard error message
    const errorText = perfError.querySelector('.perf-error-text');
    if (errorText) {
      errorText.textContent = 'Performance Profile unavailable';
    }
    
    perfLoading.hidden = true;
    perfContent.hidden = true;
    perfError.hidden   = false;
  }
}

// ── Performance Profile Retry Button ──────────────────────────────────────────
perfRetryBtn.addEventListener('click', () => {
  if (lastSearchedUsername && lastSearchedMode) {
    loadPerformanceProfile(lastSearchedUsername, lastSearchedMode);
  }
});

// ─── What's New / Changes Log ─────────────────────────────────────────────────
//
// To add a new release: prepend a new object to CHANGELOG.releases[]
// and update CHANGELOG.currentVersion.
// The automatic first-visit popup fires automatically for the new version.
//

const CHANGELOG = {
  currentVersion: 'v2.0.0',
  releases: [
    {
      version: 'v2.0.0',
      date: 'August 14, 2026',
      title: 'Point-Based Performance Profile',
      sections: [
        {
          type: 'new',
          title: '✨ Point-Based Performance Profile',
          items: [
            { desc: 'Replaced the previous 0–10 Performance Profile rating system with an unlimited Skill Point system.' },
            { desc: 'Skill Points no longer have a hard 10.0 ceiling, allowing elite players to be differentiated with granular values.' },
            { desc: 'Added construct-specific Point Anchors and Exponents for all four supported rulesets (Standard, Mania, Catch, Taiko).' },
            { desc: 'Added points_raw (2 decimal float) in backend API alongside clean integer points display.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ UI & Visual Progress Bar Progression',
          items: [
            { desc: 'Replaced "X.X / 10" display with "X,XXX pts" (e.g. 1,308 pts) across all Performance Profile cards.' },
            { desc: 'Added soft-curved visual bar scaling (70% at 1000 pts benchmark) ensuring unlimited points render smoothly without overflowing.' },
            { desc: 'Preserved the 100-candidate sample pool and adaptive deep-analysis architecture (40 Standard/Mania, 30 Catch/Taiko).' },
            { desc: 'Preserved Top-5 decay aggregation (0.90^j) and exact underlying WeightedRaw calculations.' }
          ]
        },
        {
          type: 'fixed',
          title: '🔒 Compatibility & Safety',
          items: [
            { desc: 'Added isolated v3 cache versions (v3_points_${mode}) to prevent legacy 0–10 cached results from colliding.' },
            { desc: 'Maintained strict formula integrity with zero changes to existing play-level mechanics across all 14 skill dimensions.' },
            { desc: 'Preserved responsive mobile layout across all device viewports.' }
          ]
        }
      ]
    },
    {
      version: 'v1.9',
      date: 'August 14, 2026',
      title: 'Performance Profile Optimization',
      sections: [
        {
          type: 'new',
          title: '✨ Sample Pool Expansion & Adaptive Analysis',
          items: [
            { desc: 'Expanded Performance Profile candidate pool to retrieve and evaluate up to 100 best plays.' },
            { desc: 'Added adaptive deep-analysis limits per ruleset (40 for Standard/Mania, 30 for Catch/Taiko).' },
            { desc: 'Performance Profile now distinguishes candidate plays from deeply analyzed plays.' },
            { desc: 'Added clearer analyzed-play metadata in the Performance Profile.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Throughput, Caching & Pipeline Stability',
          items: [
            { desc: 'Standard and Mania can analyze up to 40 uncached candidates.' },
            { desc: 'Catch and Taiko use up to 30 uncached deep analyses while automatically incorporating cached candidates.' },
            { desc: 'Added cache-first candidate processing to ingest pre-cached beatmaps at zero network latency.' },
            { desc: 'Added in-flight request deduplication across concurrent beatmap attribute and raw download queries.' },
            { desc: 'Added bounded request concurrency (MAX_CONCURRENCY = 4) and pacing to reduce rate-limit pressure.' },
            { desc: 'Improved statistical stability of Performance Profile results for players with deeper score histories.' },
            { desc: 'Preserved the existing Top-5 weighted aggregation with 0.90^j decay.' }
          ]
        },
        {
          type: 'fixed',
          title: '🛠️ Fairness & Robustness',
          items: [
            { desc: 'Reduced instability caused by relying on a very small subset of a player\'s best-score list.' },
            { desc: 'Prevented misleading "Based on X plays" metadata when additional candidate plays were evaluated.' }
          ]
        }
      ]
    },
    {
      version: 'v1.8.0',
      date: 'August 14, 2026',
      title: 'osu!Taiko Performance Profile',
      sections: [
        {
          type: 'new',
          title: '✨ osu!Taiko Four-Skill Performance Profile',
          items: [
            { desc: 'Added official support for the osu!Taiko game mode in BeatCard Performance Profile.' },
            { desc: 'Implemented four specialized Taiko skill dimensions: READING, SPEED, STAMINA, and TECHNICAL.' },
            { desc: 'Added Taiko-specific raw .osu beatmap analysis for accurate mechanic-level metrics.' },
            { desc: 'Added Taiko rhythm transition analysis (inter-onset interval variance and cadence shifts).' },
            { desc: 'Added P95 burst frequency analysis for precision peak speed evaluation.' },
            { desc: 'Added sustained stream duration analysis for true continuous stamina measurement.' },
            { desc: 'Added Don/Kat colour switching and 4-gram technical pattern complexity & entropy analysis.' },
            { desc: 'Added Taiko-specific fallback calculations when raw beatmap data is unavailable.' },
            { desc: 'Added FULL / REDUCED confidence handling based on raw beatmap availability.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Performance, Caching & Integration',
          items: [
            { desc: 'Added Taiko-specific cache isolation (v1_taiko).' },
            { desc: 'Added rate-aware raw beatmap caching for DT / HT / NC mod variants.' },
            { desc: 'Added batched raw .osu downloads to eliminate upstream 429 rate limit risks.' },
            { desc: 'Added Taiko ruleset-aware Performance Profile rendering with custom 4-card styling.' },
            { desc: 'Preserved existing Standard, Mania, and CTB Performance Profiles without regressions.' }
          ]
        },
        {
          type: 'fixed',
          title: '🛠️ Precision & Fairness Safeguards',
          items: [
            { desc: 'Prevented Taiko raw beatmap features from being mixed across different mod rates.' },
            { desc: 'Prevented long low-density maps from artificially inflating Stamina rating.' },
            { desc: 'Prevented simple mono-color streams from artificially inflating Technical rating.' },
            { desc: 'Separated Taiko Reading from raw object density.' },
            { desc: 'Separated Taiko Technical from overall Star Rating and raw speed dependency.' }
          ]
        }
      ]
    },
    {
      version: 'v1.7.0',
      date: 'August 14, 2026',
      title: 'CTB Two-Skill Performance Profile',
      sections: [
        {
          type: 'new',
          title: '✨ osu!catch (fruits) Performance Profile',
          items: [
            { desc: 'Added official support for the osu!catch (fruits / CTB) game mode in BeatCard Performance Profile.' },
            { desc: 'Reworked CTB skill rating model into 2 dedicated skill dimensions: MOVEMENT and ACCURACY.' },
            { desc: 'MOVEMENT leverages spatial movement analysis (P95 required velocity) from raw .osu hit object data.' },
            { desc: 'Added Hyperdash-based spatial movement feature calculation.' },
            { desc: 'Added REDUCED confidence fallback (calibrated SR × 0.225) when raw .osu data is unavailable.' },
            { desc: 'Calibrated Movement fallback multiplier from 0.35 to 0.225 to prevent rating overestimation.' },
            { desc: 'Added CTB movement confidence indicator (FULL / REDUCED).' },
            { desc: 'Added CTB-specific Accuracy calculation based on droplet judgments (fruits, 100s, 50s).' },
            { desc: 'osu!catch now displays exactly 2 performance skill cards (MOVEMENT & ACCURACY) instead of 4.' },
            { desc: 'View Profile button automatically links directly to the player\'s official osu!catch profile.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Performance & Caching',
          items: [
            { desc: 'Implemented raw .osu hit object parsing with safe 2.5-second per-request timeout.' },
            { desc: 'Added raw .osu hit object caching and batch request throttling to prevent API rate limiting.' },
            { desc: 'osu! Standard and osu!mania calculations remain 100% unchanged.' }
          ]
        },
        {
          type: 'improved',
          title: '📱 Mobile Experience',
          items: [
            { desc: 'Optimized the 2-card CTB Performance Profile grid layout for mobile viewports (320px and up).' },
            { desc: 'Maintained responsive card scaling across desktop and mobile screens.' }
          ]
        }
      ]
    },
    {
      version: 'v1.6.1',
      date: 'August 13, 2026',
      title: 'Performance & Profile Experience Update',
      sections: [
        {
          type: 'new',
          title: '✨ Player Profile',
          items: [
            { desc: "Added a View Profile button to quickly open the player's official osu! profile." },
            { desc: 'View Profile automatically follows the currently selected game mode.' },
            { desc: 'Standard profiles open directly to the osu! Standard profile page.' },
            { desc: 'Mania profiles open directly to the osu!mania profile page.' },
            { desc: 'The profile link opens in a new browser tab while keeping BeatCard open.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Performance Profile',
          items: [
            { desc: 'Recalibrated the osu! Standard Stamina calculation to better represent sustained tapping performance.' },
            { desc: 'Improved Stamina scaling across burst, stream, marathon, and high-density plays.' },
            { desc: 'Standard Stamina now uses the calibrated Candidate D model with logarithmic note-density scaling.' },
            { desc: 'Updated Standard performance caching to v24 for the new Stamina calculation.' },
            { desc: 'osu!mania Performance calculations remain unchanged.' }
          ]
        },
        {
          type: 'improved',
          title: '📱 Mobile Experience',
          items: [
            { desc: 'Optimized the View Profile action for mobile screen sizes.' },
            { desc: 'Maintained accessible touch targets and prevented horizontal overflow on narrow screens.' },
            { desc: 'View Profile remains fully usable from 320px mobile widths and above.' }
          ]
        }
      ]
    },
    {
      version: 'v1.6.0',
      date: 'August 13, 2026',
      title: 'osu!mania Performance Calibration',
      sections: [
        {
          type: 'new',
          title: '✨ osu!mania Performance Calibration',
          items: [
            { desc: 'Improved osu!mania Performance Profile calculations to better represent demonstrated player skill.' },
            { desc: 'Reworked miss penalties to account for the percentage of missed objects rather than absolute miss count.' },
            { desc: 'Miss impact is now normalized against the number of playable objects in each Mania map.' },
            { desc: 'High-difficulty players are now better represented even when their maps contain a relatively high number of misses.' },
            { desc: 'Clean execution and timing precision remain important and continue to influence the final ratings.' },
            { desc: 'Improved differentiation between Speed, Accuracy, Stamina, and LN Control specialists.' },
            { desc: 'Recalibrated the Mania skill rating scale to prevent excessive penalties from long or high-object-count maps.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Performance & Reliability',
          items: [
            { desc: 'Improved consistency of Performance Profile results across different Mania map lengths.' },
            { desc: 'Improved the distinction between map difficulty and execution quality.' },
            { desc: 'Updated Mania performance caching for the new calculation model.' },
            { desc: 'osu! Standard performance calculations remain unchanged.' }
          ]
        },
        {
          type: 'fixed',
          title: '🐛 Calibration Fixes',
          items: [
            { desc: 'Fixed excessive skill suppression caused by treating every miss as an independent absolute penalty.' },
            { desc: 'Fixed cases where players with significantly harder Mania scores could receive unexpectedly lower skill ratings than players on easier maps.' },
            { desc: 'Improved calibration between high-difficulty/high-miss performances and clean high-accuracy performances.' },
            { desc: 'Improved LN Control calibration for players with strong Long Note performance.' }
          ]
        }
      ]
    },
    {
      version: 'v1.5.3',
      date: 'August 13, 2026',
      title: 'Performance Profile Overhaul',
      sections: [
        {
          type: 'new',
          title: '✨ Performance Profile Overhaul',
          items: [
            { desc: 'Replaced Reading Demand with a new BeatCard Accuracy rating.' },
            { desc: 'Replaced OD Control with a new BeatCard Stamina rating.' },
            { desc: 'Performance Profile now focuses on four core skill areas: AIM, SPEED, ACCURACY, and STAMINA.' },
            { desc: 'Accuracy now evaluates timing precision based on the player\'s actual hit results and map difficulty.' },
            { desc: 'Stamina now evaluates sustained tapping performance using the player\'s strongest stamina plays.' },
            { desc: 'Stamina uses the player\'s top 5 stamina performances with a decay weighting system to better represent peak demonstrated stamina.' },
            { desc: 'AIM and SPEED remain based on the existing BeatCard skill calculation system.' },
            { desc: 'The Performance Profile continues to analyze up to 20 best plays.' }
          ]
        },
        {
          type: 'improved',
          title: '⚡ Performance & Reliability',
          items: [
            { desc: 'Improved the distinction between mechanical skill and timing precision.' },
            { desc: 'Performance Profile results are now more representative of different player skill specializations.' },
            { desc: 'Added updated caching for the new performance calculation system.' },
            { desc: 'Performance Profile results load independently from the main player card.' }
          ]
        },
        {
          type: 'fixed',
          title: '🐛 Bug Fixes',
          items: [
            { desc: 'Fixed a bug where the Performance Profile could remain stuck on "Analyzing best plays..." after the Reading Demand / OD Control metrics were replaced.' },
            { desc: 'Fixed stale frontend references to the removed Reading Demand and OD Control elements.' },
            { desc: 'Fixed Performance Profile progress bars not rendering correctly after the metric update.' },
            { desc: 'Improved frontend stability when rendering Accuracy and Stamina results.' }
          ]
        }
      ]
    },
    {
      version: 'v1.5.1',
      date: 'August 10, 2026',
      title: 'Mobile Experience Update',
      sections: [
        {
          type: 'new',
          title: '📱 Mobile Experience',
          items: [
            { desc: 'Added a fully responsive mobile layout for BeatCard.' },
            { desc: 'Optimized the interface for phone screen sizes from 320px up to 430px and beyond.' },
            { desc: 'Improved spacing, typography, and element sizing on smaller screens.' },
            { desc: 'Removed horizontal overflow and improved viewport fitting.' }
          ]
        },
        {
          type: 'improved',
          title: '🎴 Player Card',
          items: [
            { desc: 'Player Card preview now scales proportionally to fit mobile screens.' },
            { desc: 'The original 1200×630 PNG export remains unchanged.' },
            { desc: 'Card visuals remain consistent between desktop and mobile.' }
          ]
        },
        {
          type: 'improved',
          title: '🔎 Search & Controls',
          items: [
            { desc: 'Improved mobile search layout.' },
            { desc: 'Search controls are easier to use with touch.' },
            { desc: 'Game mode selection is optimized for smaller screens.' },
            { desc: 'Download Card and Search Another buttons now have comfortable mobile touch targets.' }
          ]
        },
        {
          type: 'improved',
          title: '📊 Performance Profile',
          items: [
            { desc: 'Performance Profile now uses a clean single-column layout on mobile.' },
            { desc: 'Metric cards, values, and progress bars are easier to read on smaller screens.' }
          ]
        },
        {
          type: 'improved',
          title: '📝 Changes Log',
          items: [
            { desc: 'Optimized the Changes Log / What\'s New modal for mobile.' },
            { desc: 'On smaller screens it uses a bottom-sheet style layout.' },
            { desc: 'Long changelog content can scroll without overflowing the viewport.' }
          ]
        },
        {
          type: 'improved',
          title: '🖥️ Desktop',
          items: [
            { desc: 'Desktop layout and existing visual design remain unchanged.' }
          ]
        }
      ]
    },
    {
      version: 'v1.5.0',
      date: 'August 10, 2026',
      title: 'Performance Profile Update',
      sections: [
        {
          type: 'new',
          title: '✨ NEW',
          items: [
            {
              name: 'Player Skill Ratings',
              desc: 'BeatCard now generates derived player skill ratings for Aim, Speed, Reading Demand, and OD Control. Ratings are presented on a 0–10 scale.'
            }
          ]
        },
        {
          type: 'improved',
          title: '📊 IMPROVED',
          items: [
            {
              name: '20 Best Plays',
              desc: "Performance analysis now uses up to 20 best plays instead of 10 for a more stable representation of the player's demonstrated skill."
            }
          ]
        },
        {
          type: 'improved',
          title: '⚡ IMPROVED',
          items: [
            {
              name: 'Performance Cache',
              desc: 'Performance results are cached so repeated searches for the same player are significantly faster.'
            }
          ]
        },
        {
          type: 'fixed',
          title: '🐛 FIXED',
          items: [
            { desc: 'Fixed playtime display/calculation issues.' },
            { desc: 'Fixed player level rendering.' },
            { desc: 'Fixed Performance Profile rendering/loading issues.' },
            { desc: 'Fixed cached performance results using outdated 10-play calculations.' },
            { desc: 'Fixed PNG rendering/export issues.' }
          ]
        },
        {
          type: 'limitations',
          title: '⚠️ KNOWN LIMITATIONS',
          items: [
            { desc: 'Performance Profile currently supports osu! Standard only.' },
            { desc: 'BeatCard Skill Ratings are BeatCard-derived estimates. They are NOT official osu! statistics.' }
          ]
        }
      ]
    }
  ]
};

// ── Modal DOM refs ────────────────────────────────────────────────────────────
const clModal   = document.getElementById('changelogModal');
const clBadge   = clModal ? clModal.querySelector('.changelog-badge') : null;
const clTitle   = document.getElementById('changelogTitle');
const clVersion = document.getElementById('changelogVersion');
const clDate    = document.getElementById('changelogDate');
const clBody    = document.getElementById('changelogBody');
const clCloseX  = document.getElementById('changelogCloseX');
const clGotIt   = document.getElementById('changelogGotIt');
const clBtn     = document.getElementById('changelogBtn'); // persistent header button

// ── Shared: render sections into a container ─────────────────────────────────
function renderSections(container, sections) {
  sections.forEach(sec => {
    if (!sec.items || sec.items.length === 0) return;

    const sectionEl = document.createElement('div');
    sectionEl.className = `changelog-section changelog-section--${sec.type}`;

    const titleEl = document.createElement('h3');
    titleEl.className = 'changelog-section-title';
    titleEl.textContent = sec.title;
    sectionEl.appendChild(titleEl);

    const hasItemNames = sec.items.some(item => item.name);

    if (!hasItemNames) {
      const listEl = document.createElement('ul');
      listEl.className = 'changelog-list';
      sec.items.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item.desc;
        listEl.appendChild(li);
      });
      sectionEl.appendChild(listEl);
    } else {
      sec.items.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = 'changelog-item';

        if (item.name) {
          const p = document.createElement('p');
          p.className = 'changelog-item-title';
          p.textContent = item.name;
          itemEl.appendChild(p);
        }

        const d = document.createElement('p');
        d.className = 'changelog-item-desc';
        d.textContent = item.desc;
        itemEl.appendChild(d);

        sectionEl.appendChild(itemEl);
      });
    }

    container.appendChild(sectionEl);
  });
}

// ── Show/close modal ─────────────────────────────────────────────────────────
function openModal(onClose) {
  if (!clModal) return;
  clModal.hidden = false;

  let closed = false;
  const doClose = () => {
    if (closed) return;
    closed = true;
    clModal.hidden = true;
    clModal.classList.remove('changelog-mode-history');
    document.removeEventListener('keydown', handleEsc);
    if (onClose) onClose();
  };

  clCloseX.onclick = doClose;
  clGotIt.onclick  = doClose;

  clModal.onclick = (e) => {
    if (e.target === clModal) doClose();
  };

  function handleEsc(e) {
    if (e.key === 'Escape') doClose();
  }
  document.addEventListener('keydown', handleEsc);
}

// ── Auto first-visit "What's New" popup ──────────────────────────────────────
function initChangelog() {
  const modalKey = `beatcard_changelog_${CHANGELOG.currentVersion}`;
  if (localStorage.getItem(modalKey)) return;

  const current = CHANGELOG.releases.find(r => r.version === CHANGELOG.currentVersion);
  if (!current || !clModal) return;

  clModal.classList.remove('changelog-mode-history');
  if (clBadge) clBadge.textContent = "WHAT'S NEW";
  clTitle.textContent   = current.title;
  clVersion.textContent = current.version;
  clDate.textContent    = current.date;
  clGotIt.textContent   = 'Got it';

  clBody.innerHTML = '';
  renderSections(clBody, current.sections);

  openModal(() => {
    // Mark as seen only when the auto-popup is dismissed
    localStorage.setItem(modalKey, 'true');
  });
}

// ── Manual "Changes Log" button — full release history ───────────────────────
function openChangelogHistory() {
  if (!clModal) return;

  clModal.classList.add('changelog-mode-history');
  if (clBadge) clBadge.textContent = 'CHANGES LOG';
  clTitle.textContent   = 'Release History';
  clVersion.textContent = '';
  clDate.textContent    = '';
  clGotIt.textContent   = 'Close';

  clBody.innerHTML = '';

  // Releases are stored newest-first; render each as its own block
  CHANGELOG.releases.forEach(release => {
    const entryEl = document.createElement('div');
    entryEl.className = 'changelog-release-entry';

    const headerRow = document.createElement('div');
    headerRow.className = 'changelog-release-header';

    const versionEl = document.createElement('span');
    versionEl.className = 'changelog-release-version';
    versionEl.textContent = release.version;
    headerRow.appendChild(versionEl);

    if (release.version === CHANGELOG.currentVersion) {
      const badge = document.createElement('span');
      badge.className = 'changelog-current-badge';
      badge.textContent = 'CURRENT';
      headerRow.appendChild(badge);
    }
    entryEl.appendChild(headerRow);

    const titleEl = document.createElement('p');
    titleEl.className = 'changelog-release-title';
    titleEl.textContent = release.title;
    entryEl.appendChild(titleEl);

    const dateEl = document.createElement('p');
    dateEl.className = 'changelog-release-date';
    dateEl.textContent = release.date;
    entryEl.appendChild(dateEl);

    renderSections(entryEl, release.sections);
    clBody.appendChild(entryEl);
  });

  // Opening the history manually does NOT mark the auto-popup as seen
  openModal(null);
}

// ── Wire up the Changes Log header button ────────────────────────────────────
if (clBtn) {
  clBtn.addEventListener('click', openChangelogHistory);
}

// ── Initialize auto-popup on page load ───────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initChangelog();
  });
} else {
  initChangelog();
}

// ── Profile confirmation modal logic ──────────────────────────────────────────
function openProfileConfirmModal(url, username, mode) {
  pendingProfileUrl = url;
  if (confirmUsername) confirmUsername.textContent = username || 'Player';
  if (confirmModeName) confirmModeName.textContent = mode === 'mania' ? 'osu!mania' : 'osu!';
  if (profileConfirmModal) profileConfirmModal.hidden = false;
}

function closeProfileConfirmModal() {
  if (profileConfirmModal) profileConfirmModal.hidden = true;
  pendingProfileUrl = '#';
}

if (viewProfileBtn) {
  viewProfileBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!viewProfileBtn.href || viewProfileBtn.href.endsWith('#')) return;
    openProfileConfirmModal(viewProfileBtn.href, currentUsername, currentMode);
  });
}

if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', closeProfileConfirmModal);
if (profileConfirmCloseX) profileConfirmCloseX.addEventListener('click', closeProfileConfirmModal);

if (confirmVisitBtn) {
  confirmVisitBtn.addEventListener('click', () => {
    if (pendingProfileUrl && !pendingProfileUrl.endsWith('#')) {
      window.open(pendingProfileUrl, '_blank', 'noopener,noreferrer');
    }
    closeProfileConfirmModal();
  });
}

if (profileConfirmModal) {
  profileConfirmModal.addEventListener('click', (e) => {
    if (e.target === profileConfirmModal) closeProfileConfirmModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && profileConfirmModal && !profileConfirmModal.hidden) {
    closeProfileConfirmModal();
  }
});
