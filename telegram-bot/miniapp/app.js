const state = {
  mode: 'miniapp',
  sessionId: null,
  adWatched: false,
  adPreloaded: false,
  chatAutoAdStarted: false
};
const THEME_STORAGE_KEY = 'snaptik-miniapp-theme';

const els = {
  modeLabel: document.getElementById('modeLabel'),
  themeToggle: document.getElementById('themeToggle'),
  inputSection: document.getElementById('inputSection'),
  previewSection: document.getElementById('previewSection'),
  previewBody: document.getElementById('previewBody'),
  adSection: document.getElementById('adSection'),
  optionsSection: document.getElementById('optionsSection'),
  optionsList: document.getElementById('optionsList'),
  chatDoneSection: document.getElementById('chatDoneSection'),
  urlInput: document.getElementById('urlInput'),
  prepareBtn: document.getElementById('prepareBtn'),
  watchAdBtn: document.getElementById('watchAdBtn'),
  statusText: document.getElementById('statusText')
};

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle('error', isError);
}

function setLoading(button, loading, loadingText = 'Processing...') {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
  }
  button.disabled = loading;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function triggerDownload(optionId) {
  const relativeTarget = `/miniapp/api/download/${encodeURIComponent(state.sessionId)}/${encodeURIComponent(optionId)}?download=1`;

  // iOS Telegram WebView often opens media inline; open externally to trigger file download UX.
  if (isIosDevice() && window.Telegram?.WebApp?.openLink) {
    const absoluteTarget = new URL(relativeTarget, window.location.origin).toString();
    window.Telegram.WebApp.openLink(absoluteTarget, { try_instant_view: false });
    return;
  }

  const anchor = document.createElement('a');
  anchor.href = relativeTarget;
  anchor.rel = 'noopener';
  anchor.target = '_blank';
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getTelegramTheme() {
  const scheme = window.Telegram?.WebApp?.colorScheme;
  if (scheme === 'dark') return 'dark';
  if (scheme === 'light') return 'light';
  return null;
}

function getSystemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readSavedTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in restricted environments
  }
}

function applyTheme(theme, { persist = false } = {}) {
  const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolvedTheme);

  if (els.themeToggle) {
    els.themeToggle.textContent = resolvedTheme === 'dark' ? '☀ Light' : '🌙 Dark';
  }

  if (persist) {
    saveTheme(resolvedTheme);
  }
}

function initTheme() {
  const savedTheme = readSavedTheme();
  const initialTheme = savedTheme || getTelegramTheme() || getSystemTheme();
  applyTheme(initialTheme);

  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next, { persist: true });
    });
  }

  if (!savedTheme && window.Telegram?.WebApp?.onEvent) {
    window.Telegram.WebApp.onEvent('themeChanged', () => {
      applyTheme(getTelegramTheme());
    });
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : {};

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function renderPreview(preview) {
  if (!preview) return;

  const parts = [];
  if (preview.cover) {
    parts.push(`<img class="preview-cover" src="${preview.cover}" alt="Cover">`);
  }

  parts.push(`
    <div class="preview-meta">
      <div><strong>Author:</strong> ${preview.author || '-'}</div>
      <div><strong>Title:</strong> ${preview.title || '-'}</div>
      <div><strong>Type:</strong> ${preview.status === 'picker' ? 'Slideshow/Photo' : 'Video'}</div>
      <div><strong>Views:</strong> ${preview.stats?.views || 0}</div>
    </div>
  `);

  els.previewBody.innerHTML = parts.join('');
  els.previewSection.classList.remove('hidden');
}

function showAdVerification() {
  els.adSection.classList.remove('hidden');
  els.optionsSection.classList.add('hidden');
}

function showDownloadOptions() {
  els.adSection.classList.add('hidden');
  els.optionsSection.classList.remove('hidden');
}

function renderOptions(options) {
  els.optionsList.innerHTML = '';

  options.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'btn primary option-btn';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      triggerDownload(item.id);
    });
    els.optionsList.appendChild(btn);
  });

  showDownloadOptions();
}

async function loadOptions() {
  const data = await request(`/miniapp/api/options/${encodeURIComponent(state.sessionId)}`);
  renderOptions(data.options || []);
}

async function preloadRewardedAd() {
  if (!state.sessionId || typeof window.show_10653178 !== 'function') return;

  try {
    await window.show_10653178({ type: 'preload', ymid: state.sessionId });
    state.adPreloaded = true;
  } catch (error) {
    state.adPreloaded = false;
  }
}

async function watchRewardedAd() {
  if (typeof window.show_10653178 !== 'function') {
    throw new Error('Monetag SDK is not ready yet. Please retry in a few seconds.');
  }

  // Rewarded interstitial
  await window.show_10653178({ ymid: state.sessionId }).then(() => {
    // Reward function is handled server-side via /miniapp/api/reward
  });
}

async function waitForMonetagSdk(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window.show_10653178 === 'function') return true;
    await sleep(150);
  }
  return typeof window.show_10653178 === 'function';
}

function showChatVerifiedState() {
  els.previewSection.classList.add('hidden');
  els.adSection.classList.add('hidden');
  els.optionsSection.classList.add('hidden');
  setStatus('Ad verified. Returning to chat...');

  const telegramWebApp = window.Telegram?.WebApp;
  if (typeof telegramWebApp?.close === 'function') {
    setTimeout(() => {
      telegramWebApp.close();
    }, 350);
    return;
  }

  // Fallback for non-Telegram environments
  els.chatDoneSection.classList.remove('hidden');
  setStatus('Ad verification completed. Return to the bot chat.');
  if (telegramWebApp?.MainButton) {
    const mainButton = telegramWebApp.MainButton;
    mainButton.setText('Back to chat');
    mainButton.show();
    mainButton.onClick(() => telegramWebApp.close());
  }
}

async function handlePrepare() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Please enter a TikTok URL first.', true);
    return;
  }

  setLoading(els.prepareBtn, true, 'Processing URL...');
  setStatus('Processing TikTok URL...');

  try {
    const data = await request('/miniapp/api/prepare', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    state.sessionId = data.sessionId;
    state.adWatched = false;

    renderPreview(data.preview);
    showAdVerification();
    if (state.mode === 'miniapp') {
      els.inputSection.classList.add('hidden');
    }
    els.chatDoneSection.classList.add('hidden');
    setStatus('URL is valid. Watch an ad to unlock format options.');
    preloadRewardedAd();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setLoading(els.prepareBtn, false);
  }
}

async function handleWatchAd({ auto = false } = {}) {
  if (!state.sessionId) {
    setStatus('Session is missing. Submit a TikTok URL first.', true);
    return;
  }

  if (!auto) {
    setLoading(els.watchAdBtn, true, 'Opening ad...');
    setStatus('Waiting for ad completion...');
  } else {
    setStatus('Opening rewarded ad...');
  }

  try {
    const sdkReady = await waitForMonetagSdk();
    if (!sdkReady) {
      throw new Error('Ad SDK is still loading. Please tap Retry ad.');
    }

    await watchRewardedAd();

    await request('/miniapp/api/reward', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId })
    });

    state.adWatched = true;

    if (state.mode === 'chat') {
      showChatVerifiedState();
      return;
    }

    await loadOptions();
    els.adSection.classList.add('hidden');
    setStatus('Ad verified. Choose a download format below.');
  } catch (error) {
    if (state.mode === 'chat') {
      // Fallback: only show retry button when auto-open fails.
      els.adSection.classList.remove('hidden');
      els.watchAdBtn.textContent = '▶ Retry Ad';
      const adHint = document.getElementById('adHint');
      if (adHint) {
        adHint.textContent = 'Auto-open failed. Tap Retry Ad to continue.';
      }
    }
    setStatus(error.message || 'Failed to show ad.', true);
  } finally {
    if (!auto) {
      setLoading(els.watchAdBtn, false);
    }
  }
}

async function initChatMode(sessionId) {
  state.mode = 'chat';
  state.sessionId = sessionId;

  els.modeLabel.textContent = 'Chat mode: opening ad...';
  els.inputSection.classList.add('hidden');
  els.previewSection.classList.add('hidden');
  els.optionsSection.classList.add('hidden');
  els.chatDoneSection.classList.add('hidden');
  els.adSection.classList.add('hidden');

  setStatus('Loading chat session...');

  try {
    const data = await request(`/miniapp/api/session/${encodeURIComponent(sessionId)}`);

    if (data.adWatched) {
      state.adWatched = true;
      showChatVerifiedState();
      setStatus('This session is already verified. Return to bot chat.');
    } else {
      preloadRewardedAd();
      if (!state.chatAutoAdStarted) {
        state.chatAutoAdStarted = true;
        await handleWatchAd({ auto: true });
      }
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

function init() {
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
  }
  initTheme();

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const sessionId = params.get('session');

  els.prepareBtn.addEventListener('click', handlePrepare);
  els.watchAdBtn.addEventListener('click', () => handleWatchAd());

  if (mode === 'chat' && sessionId) {
    initChatMode(sessionId);
  }
}

document.addEventListener('DOMContentLoaded', init);
