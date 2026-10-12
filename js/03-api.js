// ============================================================================
// 03-api.js — Rate limiter + appels API YGOPRODeck (fallback si JSON absents)
// ============================================================================

const apiQueue = [];
let apiBusy = false;

function enqueueApiFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    apiQueue.push({ url, options, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (apiBusy) return;
  apiBusy = true;
  while (apiQueue.length) {
    const job = apiQueue.shift();
    try {
      const result = await rawFetchWithRetry(job.url, job.options);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    }
    await sleep(MIN_DELAY_MS);
  }
  apiBusy = false;
}

async function rawFetchWithRetry(url, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const extSignal = options.signal;
  if (extSignal) {
    if (extSignal.aborted) {
      clearTimeout(timeoutId);
      const e = new Error("Aborted"); e.name = "AbortError"; throw e;
    }
    extSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.warn(`API ${res.status}, retry dans ${delay}ms`);
      await sleep(delay);
      return rawFetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError" && extSignal && extSignal.aborted) throw err;
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      await sleep(delay);
      return rawFetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function apiFetchCards(params, signal) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((val) => url.searchParams.append(k, val));
    else url.searchParams.set(k, v);
  });
  const res = await enqueueApiFetch(url.toString(), signal ? { signal } : {});
  if (!res.ok) {
    if (res.status === 400) return [];
    throw new Error(`API error ${res.status}`);
  }
  const data = await res.json();
  return data.data || [];
}

async function getCardsByIds(ids, language) {
  if (!ids.length) return new Map();
  const results = new Map();
  const uncached = [];
  const cache = language === "fr" ? cardFrByIdCache : cardByIdCache;
  for (const id of ids) {
    const key = String(id);
    if (cache.has(key)) results.set(key, cache.get(key));
    else uncached.push(key);
  }
  if (!uncached.length) return results;
  for (let i = 0; i < uncached.length; i += BATCH_ID_LIMIT) {
    const chunk = uncached.slice(i, i + BATCH_ID_LIMIT);
    const params = { id: chunk.join(",") };
    if (language === "fr") params.language = "fr";
    try {
      const cards = await apiFetchCards(params);
      for (const card of cards) {
        const key = String(card.id);
        cache.set(key, card);
        results.set(key, card);
      }
      for (const id of chunk) if (!results.has(id)) results.set(id, null);
    } catch (err) { console.warn("[API] Batch échoué", err); }
  }
  return results;
}
