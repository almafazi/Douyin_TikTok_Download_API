import { createLogger } from './logger.js';

const logger = createLogger('SnaptikAPI');

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Snaptik/1.0'
};

const DEFAULT_TIKTOK_BASES = [
  'https://f.snaptik.fit',
  'https://f2.snaptik.fit',
  'https://f3.snaptik.fit'
];

const DEFAULT_DOUYIN_PRIMARY = 'https://douyin.snaptik.fit';
const DEFAULT_DOUYIN_FALLBACK = 'https://douyin2.snaptik.fit';
const DEFAULT_TIMEOUT_MS = 15000;

function parseBases(raw, fallback) {
  if (!raw || typeof raw !== 'string') return [...fallback];
  const bases = raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return bases.length > 0 ? bases : [...fallback];
}

function getConfig() {
  const apiKey = process.env.API_KEY?.trim() || '';
  const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS;

  let tiktokBases = parseBases(process.env.TIKTOK_API_BASES, DEFAULT_TIKTOK_BASES);

  // Legacy single-host override when TIKTOK_API_BASES is unset
  if (!process.env.TIKTOK_API_BASES && process.env.API_BASE_URL) {
    const legacy = process.env.API_BASE_URL.trim().replace(/\/+$/, '');
    if (legacy) {
      tiktokBases = [legacy];
    }
  }

  const douyinPrimary = (process.env.DOUYIN_API_PRIMARY || DEFAULT_DOUYIN_PRIMARY).trim().replace(/\/+$/, '');
  const douyinFallback = (process.env.DOUYIN_API_FALLBACK || DEFAULT_DOUYIN_FALLBACK).trim().replace(/\/+$/, '');

  return {
    apiKey,
    timeoutMs,
    tiktokBases,
    douyinPrimary,
    douyinFallback
  };
}

export function isDouyinUrl(url) {
  if (typeof url !== 'string') return false;
  return url.includes('douyin.com') || url.includes('.douyin.com');
}

export function isSupportedMediaUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  return (
    trimmed.includes('tiktok.com') ||
    trimmed.includes('douyin.com') ||
    trimmed.includes('.douyin.com')
  );
}

export function resolveDownloadUrl(value, base) {
  if (!value) return value;
  if (Array.isArray(value)) return value.map((val) => resolveDownloadUrl(val, base));
  if (typeof value !== 'string') return value;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (!base) return value;
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

export function normalizePayload(response, winnerBase) {
  const dl = response?.download_link || {};
  const stats = response?.statistics || {};

  const photos = Array.isArray(response?.photos)
    ? response.photos.map((photo) => {
      if (!photo || typeof photo === 'string') {
        const url = typeof photo === 'string' ? photo : null;
        return url ? { type: 'photo', url } : photo;
      }
      return {
        ...photo,
        url: resolveDownloadUrl(photo.url || photo.download_url || photo.src, winnerBase),
        download_link: resolveDownloadUrl(photo.download_link, winnerBase)
      };
    })
    : response?.photos;

  const coverFromPhotos = Array.isArray(photos)
    ? (photos.find((p) => typeof p?.url === 'string' && p.url.startsWith('http'))?.url || null)
    : null;

  const cover = (typeof response?.cover === 'string' && response.cover.startsWith('http'))
    ? response.cover
    : coverFromPhotos;

  return {
    ...response,
    cover: cover || null,
    statistics: {
      repost_count: stats.repost_count ?? stats.share_count ?? 0,
      share_count: stats.share_count ?? stats.repost_count ?? 0,
      comment_count: stats.comment_count ?? 0,
      digg_count: stats.digg_count ?? 0,
      play_count: stats.play_count ?? 0
    },
    photos,
    download_link: {
      ...dl,
      watermark: resolveDownloadUrl(dl.watermark, winnerBase),
      no_watermark: resolveDownloadUrl(dl.no_watermark, winnerBase),
      no_watermark_hd: resolveDownloadUrl(dl.no_watermark_hd, winnerBase),
      mp3: resolveDownloadUrl(dl.mp3, winnerBase)
    },
    download_slideshow_link: resolveDownloadUrl(
      response?.download_slideshow || response?.download_slideshow_link,
      winnerBase
    )
  };
}

async function postJson(url, { json, headers, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, ...headers },
    body: JSON.stringify(json),
    signal
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }

    let parsed;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = null;
    }

    const err = new Error(
      parsed?.error || parsed?.message || `Request failed with status ${res.status}: ${url}`
    );
    err.name = 'HTTPError';
    err.status = res.status;
    err.responseBody = parsed || bodyText;
    throw err;
  }

  return res.json();
}

function createTimeoutSignal(timeoutMs, externalController) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const signals = [timeoutController.signal];
  if (externalController) {
    signals.push(externalController.signal);
  }

  let combined;
  if (typeof AbortSignal.any === 'function') {
    combined = AbortSignal.any(signals);
  } else {
    combined = timeoutController.signal;
    if (externalController) {
      externalController.signal.addEventListener(
        'abort',
        () => timeoutController.abort(externalController.signal.reason),
        { once: true }
      );
    }
  }

  return {
    signal: combined,
    clear: () => clearTimeout(timer)
  };
}

async function fetchTikTokHedged(url, config) {
  if (!config.apiKey) {
    const err = new Error('Server API key is not configured');
    err.code = 'API_KEY_MISSING';
    err.status = 500;
    throw err;
  }

  const bases = config.tiktokBases;
  if (!bases.length) {
    const err = new Error('No TikTok API bases configured');
    err.code = 'NO_API_BASES';
    err.status = 500;
    throw err;
  }

  const controllers = bases.map(() => new AbortController());
  const body = { url, proxy: null, impersonate: 'chrome' };
  const headers = { 'X-API-Key': config.apiKey };

  const wrapped = bases.map((base, index) => {
    const external = controllers[index];
    const { signal, clear } = createTimeoutSignal(config.timeoutMs, external);
    const started = Date.now();

    return postJson(`${base}/tiktok`, {
      json: body,
      headers,
      signal
    })
      .then((response) => {
        controllers.forEach((ctrl, i) => {
          if (i !== index) ctrl.abort();
        });
        return { response, base, ms: Date.now() - started };
      })
      .finally(clear);
  });

  try {
    const winner = await Promise.any(wrapped);
    logger.info({ base: winner.base, ms: winner.ms }, 'tiktok api winner');
    return winner;
  } catch (aggregateError) {
    const errors = aggregateError?.errors || [];
    logger.error(
      { errors: errors.map((e) => e?.message || String(e)) },
      'TikTok hedged APIs all failed'
    );

    for (const err of errors) {
      if (err?.name === 'HTTPError' && err?.status) {
        const out = new Error(err.message || 'Failed to fetch TikTok data');
        out.status = err.status;
        out.responseBody = err.responseBody;
        throw out;
      }
    }

    const out = new Error('Failed to fetch TikTok data from all providers');
    out.status = 502;
    throw out;
  }
}

async function fetchDouyinSequential(url, config) {
  const hosts = [config.douyinPrimary, config.douyinFallback].filter(Boolean);
  let lastError;

  for (const base of hosts) {
    try {
      const { signal, clear } = createTimeoutSignal(config.timeoutMs);
      try {
        const started = Date.now();
        const response = await postJson(`${base}/tiktok`, {
          json: { url },
          headers: {},
          signal
        });
        logger.info({ base, ms: Date.now() - started }, 'douyin api winner');
        return { response, base };
      } finally {
        clear();
      }
    } catch (error) {
      lastError = error;
      logger.warn({ base, err: error.message }, 'Douyin API host failed');
    }
  }

  if (lastError?.name === 'HTTPError') {
    const out = new Error(lastError.message || 'Failed to fetch Douyin data');
    out.status = lastError.status || 502;
    out.responseBody = lastError.responseBody;
    throw out;
  }

  const out = new Error(lastError?.message || 'Failed to fetch Douyin data from all providers');
  out.status = 502;
  throw out;
}

/**
 * Fetch TikTok/Douyin metadata using snaptik-new client pattern.
 * @param {string} url
 * @returns {Promise<{ data: object, apiBase: string }>}
 */
export async function fetchTikTokData(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    const err = new Error('URL is required');
    err.status = 400;
    err.code = 'URL_REQUIRED';
    throw err;
  }

  const tiktokUrl = url.trim();
  if (!isSupportedMediaUrl(tiktokUrl)) {
    const err = new Error('Invalid TikTok URL');
    err.status = 400;
    err.code = 'INVALID_URL';
    throw err;
  }

  const config = getConfig();
  const isDouyin = isDouyinUrl(tiktokUrl);

  const { response, base } = isDouyin
    ? await fetchDouyinSequential(tiktokUrl, config)
    : await fetchTikTokHedged(tiktokUrl, config);

  const data = normalizePayload(response, base);
  return { data, apiBase: base };
}

/**
 * Probe configured API hosts for /stats.
 */
export async function checkApisHealth() {
  const config = getConfig();
  const hosts = [
    ...config.tiktokBases.map((base) => ({ base, kind: 'tiktok' })),
    { base: config.douyinPrimary, kind: 'douyin' },
    { base: config.douyinFallback, kind: 'douyin' }
  ].filter((item, index, arr) => item.base && arr.findIndex((x) => x.base === item.base) === index);

  const results = await Promise.all(
    hosts.map(async ({ base, kind }) => {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(`${base}/health`, {
            method: 'GET',
            headers: { 'User-Agent': 'Snaptik/1.0' },
            signal: controller.signal
          });
          return {
            base,
            kind,
            status: res.ok ? 'online' : 'degraded',
            httpStatus: res.status,
            ms: Date.now() - started
          };
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return {
          base,
          kind,
          status: 'offline',
          httpStatus: null,
          ms: Date.now() - started
        };
      }
    })
  );

  const anyOnline = results.some((r) => r.status === 'online');
  return {
    status: anyOnline ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    apiKeyConfigured: Boolean(config.apiKey),
    hosts: results
  };
}

/**
 * Build slideshow download URL from token or absolute URL.
 */
export function resolveSlideshowUrl(encryptedOrUrl, apiBase, fallbackBases = []) {
  if (!encryptedOrUrl) return null;
  if (typeof encryptedOrUrl === 'string' && encryptedOrUrl.startsWith('http')) {
    return encryptedOrUrl;
  }

  const bases = [apiBase, ...fallbackBases].filter(Boolean);
  const base = bases[0] || getConfig().tiktokBases[0];
  if (!base) return null;

  return `${base}/download-slideshow?url=${encodeURIComponent(encryptedOrUrl)}`;
}

export function getTikTokApiBases() {
  return getConfig().tiktokBases;
}
