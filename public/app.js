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

// Performance Profile DOM references
const perfProfileContainer = document.getElementById('perfProfileContainer');
const perfLoading          = document.getElementById('perfLoading');
const perfError            = document.getElementById('perfError');
const perfRetryBtn         = document.getElementById('perfRetryBtn');
const perfContent          = document.getElementById('perfContent');

const perfValAim           = document.getElementById('perfValAim');
const perfValSpeed         = document.getElementById('perfValSpeed');
const perfValReading       = document.getElementById('perfValReading');
const perfValOd            = document.getElementById('perfValOd');

const perfBarAim           = document.getElementById('perfBarAim');
const perfBarSpeed         = document.getElementById('perfBarSpeed');
const perfBarReading       = document.getElementById('perfBarReading');
const perfBarOd            = document.getElementById('perfBarOd');

const perfSampleSize       = document.getElementById('perfSampleSize');

// Track the current player for the download filename and retries
let currentUsername      = '';
let lastSearchedUsername = '';
let lastSearchedMode     = '';

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
  
  // Format numeric values
  perfValAim.textContent     = `${Number(m.aim ?? 0).toFixed(1)} / 10`;
  perfValSpeed.textContent   = `${Number(m.speed ?? 0).toFixed(1)} / 10`;
  perfValReading.textContent = `${Number(m.reading_demand ?? 0).toFixed(1)} / 10`;
  perfValOd.textContent      = `${Number(m.od_control ?? 0).toFixed(1)} / 10`;

  // Update progress bars (normalized against 10)
  // Ensure we clamp values between 0 and 10 for safe bar widths (0% to 100%)
  const clampWidth = (val) => Math.max(0, Math.min(100, (Number(val ?? 0) * 10)));
  
  // Use timeout to allow transition to trigger smoothly after element display
  setTimeout(() => {
    perfBarAim.style.width     = `${clampWidth(m.aim)}%`;
    perfBarSpeed.style.width   = `${clampWidth(m.speed)}%`;
    perfBarReading.style.width = `${clampWidth(m.reading_demand)}%`;
    perfBarOd.style.width      = `${clampWidth(m.od_control)}%`;
  }, 50);

  // Set sample size text dynamically
  perfSampleSize.textContent = `Based on ${data.sample_size} best plays`;
  
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

  // For V1, we only calculate performance profiles for Standard (osu) mode.
  // Gated on frontend to prevent useless API calls.
  if (mode !== 'osu') {
    perfProfileContainer.hidden = true;
    return;
  }

  // Reset display & show loading
  perfProfileContainer.hidden = false;
  perfLoading.hidden          = false;
  perfError.hidden            = true;
  perfContent.hidden          = true;

  // Reset bar widths to 0 so they animate out and back in
  perfBarAim.style.width     = '0%';
  perfBarSpeed.style.width   = '0%';
  perfBarReading.style.width = '0%';
  perfBarOd.style.width      = '0%';

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

// ─── What's New Changelog Modal ───────────────────────────────────────────────

const CHANGELOG = {
  version: "v1.5.0",
  date: "August 10, 2026",
  title: "Performance Profile Update",
  sections: [
    {
      type: "new",
      title: "✨ NEW",
      items: [
        {
          name: "Player Skill Ratings",
          desc: "BeatCard now generates derived player skill ratings for Aim, Speed, Reading Demand, and OD Control. Ratings are presented on a 0–10 scale."
        }
      ]
    },
    {
      type: "improved",
      title: "📊 IMPROVED",
      items: [
        {
          name: "20 Best Plays",
          desc: "Performance analysis now uses up to 20 best plays instead of 10 for a more stable representation of the player's demonstrated skill."
        }
      ]
    },
    {
      type: "improved",
      title: "⚡ IMPROVED",
      items: [
        {
          name: "Performance Cache",
          desc: "Performance results are cached so repeated searches for the same player are significantly faster."
        }
      ]
    },
    {
      type: "fixed",
      title: "🐛 FIXED",
      items: [
        { desc: "Fixed playtime display/calculation issues." },
        { desc: "Fixed player level rendering." },
        { desc: "Fixed Performance Profile rendering/loading issues." },
        { desc: "Fixed cached performance results using outdated 10-play calculations." },
        { desc: "Fixed PNG rendering/export issues." }
      ]
    },
    {
      type: "limitations",
      title: "⚠️ KNOWN LIMITATIONS",
      items: [
        { desc: "Performance Profile currently supports osu! Standard only." },
        { desc: "BeatCard Skill Ratings are BeatCard-derived estimates. They are NOT official osu! statistics." }
      ]
    }
  ]
};

function initChangelog() {
  const modalKey = `beatcard_changelog_${CHANGELOG.version}`;
  const isSeen = localStorage.getItem(modalKey);

  if (isSeen) return;

  const modal = document.getElementById('changelogModal');
  const title = document.getElementById('changelogTitle');
  const version = document.getElementById('changelogVersion');
  const date = document.getElementById('changelogDate');
  const body = document.getElementById('changelogBody');
  const closeX = document.getElementById('changelogCloseX');
  const gotItBtn = document.getElementById('changelogGotIt');

  if (!modal || !body) return;

  // Set header info
  title.textContent = CHANGELOG.title;
  version.textContent = CHANGELOG.version;
  date.textContent = CHANGELOG.date;

  // Clear existing content
  body.innerHTML = '';

  // Render sections
  CHANGELOG.sections.forEach(sec => {
    if (!sec.items || sec.items.length === 0) return;

    const sectionEl = document.createElement('div');
    sectionEl.className = `changelog-section changelog-section--${sec.type}`;

    const titleEl = document.createElement('h3');
    titleEl.className = 'changelog-section-title';
    titleEl.textContent = sec.title;
    sectionEl.appendChild(titleEl);

    // If section contains only items with description (no item name, like fixes/limitations)
    // render them as a bulleted list
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
          const itemTitle = document.createElement('p');
          itemTitle.className = 'changelog-item-title';
          itemTitle.textContent = item.name;
          itemEl.appendChild(itemTitle);
        }

        const itemDesc = document.createElement('p');
        itemDesc.className = 'changelog-item-desc';
        itemDesc.textContent = item.desc;
        itemEl.appendChild(itemDesc);

        sectionEl.appendChild(itemEl);
      });
    }

    body.appendChild(sectionEl);
  });

  // Show modal
  modal.hidden = false;

  const closeModal = () => {
    localStorage.setItem(modalKey, 'true');
    modal.hidden = true;
    document.removeEventListener('keydown', handleEsc);
  };

  closeX.onclick = closeModal;
  gotItBtn.onclick = closeModal;

  // Backdrop click closes the modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };

  // Keyboard Escape support
  function handleEsc(e) {
    if (e.key === 'Escape') {
      closeModal();
    }
  }
  document.addEventListener('keydown', handleEsc);
}

// Initialize changelog on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChangelog);
} else {
  initChangelog();
}

