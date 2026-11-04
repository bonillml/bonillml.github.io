/*
 * Tweet Triage: front end
 *
 * HOW THIS PAGE TALKS TO YOUR MODEL
 * ---------------------------------
 * Set CONFIG.API_URL below to your model's endpoint. The page sends one
 * multipart/form-data POST. Fields depend on the mode:
 *
 *   mode        "link" | "html" | "pair"             (always sent)
 *   tweet_url   the tweet link                       (mode "link")
 *   tweet_html  the pasted HTML                      (mode "html")
 *   text        the tweet text                       (mode "pair")
 *   images      1-4 image files, repeated field      (mode "pair")
 *
 * It expects JSON back. Class order matches training: 0 = not informative,
 * 1 = informative. Any ONE of these shapes works:
 *
 *   { "probabilities": { "informative": 0.93, "not_informative": 0.07 } }
 *   { "probabilities": [0.07, 0.93] }                  // [not informative, informative]
 *   { "label": "informative", "confidence": 0.93 }
 *
 * Optional extras:
 *   "tweet":     { "text": "...", "images": ["https://...", "data:image/png;base64,..."] }
 *                   what the server resolved from a link or HTML (shown in the readout)
 *   "per_image": [ { "probabilities": {...} }, ... ]   one entry per image in tweet.images
 *
 * Errors: any non-2xx reply is shown to the person. Use { "detail": "message" }
 * (FastAPI style) or { "error": "message" } to control the wording.
 *
 * If the model lives in a different Space, use its full URL here, for example
 * "https://your-name-your-space.hf.space/predict", and enable CORS on that server.
 *
 * Add ?demo=1 to this page's address to preview the design with simulated
 * results (no server needed). Demo results are labeled as simulated.
 */
(() => {
  'use strict';

  const CONFIG = {
    API_URL: '/predict',
    TIMEOUT_MS: 120000,       // Spaces can need a minute to wake up
    SLOW_NOTICE_MS: 8000,
    MAX_IMAGES: 4,
    MAX_IMAGE_MB: 10,
    MAX_TEXT_CHARS: 2000,
    MAX_HTML_CHARS: 500000,
    THEME_KEY: 'tt-theme',
  };

  const DEMO = new URLSearchParams(window.location.search).has('demo');
  const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_BYTES = CONFIG.MAX_IMAGE_MB * 1024 * 1024;
  const TWEET_URL_RE =
    /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/\d+(?:[/?#].*)?$/i;
  const LABEL_NAMES = { informative: 'Informative', not_informative: 'Not informative' };
  const CLOSE_CALL = 0.65;

  const $ = (id) => document.getElementById(id);
  const mq = (query) =>
    window.matchMedia ? window.matchMedia(query) : { matches: false, addEventListener() {} };

  const els = {
    form: $('tweet-form'),
    tablist: $('tablist'),
    tabs: Array.from(document.querySelectorAll('[role="tab"]')),
    url: $('tweet-url'),
    urlError: $('tweet-url-error'),
    html: $('tweet-html'),
    htmlError: $('tweet-html-error'),
    text: $('tweet-text'),
    textError: $('tweet-text-error'),
    counter: $('text-count'),
    fileInput: $('image-input'),
    dropzone: $('dropzone'),
    dzTitle: $('dz-title'),
    dzHint: $('dz-hint'),
    imageHelp: $('image-help'),
    imageError: $('image-error'),
    previews: $('previews'),
    submit: $('submit-btn'),
    submitLabel: $('submit-label'),
    clear: $('clear-btn'),
    formError: $('form-error'),
    readout: $('readout'),
    status: $('status'),
    verdict: $('verdict'),
    verdictNote: $('verdict-note'),
    track: $('track'),
    marker: $('marker'),
    markerValue: $('marker-value'),
    numInf: $('num-inf'),
    numNot: $('num-not'),
    pInf: $('p-inf'),
    pNot: $('p-not'),
    echo: $('echo'),
    echoQuote: $('echo-quote'),
    echoText: $('echo-text'),
    echoImages: $('echo-images'),
    meta: $('meta'),
    themeToggle: $('theme-toggle'),
    demoPill: $('demo-pill'),
  };

  const state = {
    mode: 'link',
    files: [],          // [{ file, url }] for the "pair" mode previews
    resultUrls: [],     // object URLs created for the readout, revoked on reset
    busy: false,
    slowTimer: null,
  };

  class UserError extends Error {}

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                      */
  /* ------------------------------------------------------------------ */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const fmtPct = (p, digits = 1) => `${(p * 100).toFixed(digits)}%`;
  const reduceMotion = () => mq('(prefers-reduced-motion: reduce)').matches;

  function revokeAll(urls) {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                              */
  /* ------------------------------------------------------------------ */
  function storedTheme() {
    try {
      const value = localStorage.getItem(CONFIG.THEME_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function systemTheme() {
    return mq('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
    els.themeToggle.setAttribute('aria-label', label);
    els.themeToggle.setAttribute('title', label);
  }

  function initTheme() {
    applyTheme(storedTheme() || systemTheme());
    els.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(CONFIG.THEME_KEY, next); } catch (e) { /* storage blocked */ }
    });
    // Follow the system setting until the person picks a theme themselves.
    mq('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!storedTheme()) applyTheme(systemTheme());
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                               */
  /* ------------------------------------------------------------------ */
  function selectMode(mode, { focus = false } = {}) {
    state.mode = mode;
    for (const tab of els.tabs) {
      const active = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) tab.focus();
    }
    clearErrors();
  }

  function onTabKeydown(event) {
    const index = els.tabs.indexOf(document.activeElement);
    if (index === -1) return;
    const last = els.tabs.length - 1;
    let next = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    selectMode(els.tabs[next].dataset.mode, { focus: true });
  }

  /* ------------------------------------------------------------------ */
  /* Errors                                                             */
  /* ------------------------------------------------------------------ */
  const FIELD_PAIRS = () => [
    [els.url, els.urlError],
    [els.html, els.htmlError],
    [els.text, els.textError],
    [els.fileInput, els.imageError],
  ];

  function showFieldError(input, errorEl, message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  function clearErrors() {
    for (const [input, errorEl] of FIELD_PAIRS()) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      input.removeAttribute('aria-invalid');
    }
    els.formError.hidden = true;
    els.formError.textContent = '';
  }

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
    els.formError.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  /* ------------------------------------------------------------------ */
  /* Photos                                                             */
  /* ------------------------------------------------------------------ */
  function sameFile(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }

  function updateDropzone() {
    const full = state.files.length >= CONFIG.MAX_IMAGES;
    els.fileInput.disabled = full;
    els.dropzone.classList.toggle('is-full', full);
    els.dzTitle.textContent = full ? `${CONFIG.MAX_IMAGES} photos added` : 'Add photos';
    els.dzHint.textContent = full
      ? 'Remove one to add a different photo.'
      : 'Drop images here, click to browse, or paste a screenshot.';
  }

  function renderPreviews() {
    els.previews.replaceChildren(
      ...state.files.map((item) => {
        const remove = h('button', {
          type: 'button',
          class: 'remove',
          'aria-label': `Remove ${item.file.name}`,
        });
        remove.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
          'stroke-width="2.5" stroke-linecap="round" aria-hidden="true" focusable="false">' +
          '<path d="M6 6l12 12M18 6L6 18"/></svg>';
        remove.addEventListener('click', () => removeFile(item));
        return h(
          'li',
          { class: 'preview' },
          h('img', { src: item.url, alt: `Preview of ${item.file.name}` }),
          h('span', { class: 'preview-name', text: item.file.name }),
          remove
        );
      })
    );
  }

  function removeFile(item) {
    URL.revokeObjectURL(item.url);
    state.files = state.files.filter((f) => f !== item);
    renderPreviews();
    updateDropzone();
    clearImageError();
    if (!els.fileInput.disabled) els.fileInput.focus();
  }

  function clearImageError() {
    els.imageError.hidden = true;
    els.imageError.textContent = '';
    els.fileInput.removeAttribute('aria-invalid');
  }

  function addFiles(fileList) {
    const skippedType = [];
    const skippedSize = [];
    let skippedLimit = 0;

    for (const file of Array.from(fileList)) {
      if (!ALLOWED_TYPES.has(file.type)) { skippedType.push(file.name); continue; }
      if (file.size > MAX_BYTES) { skippedSize.push(file.name); continue; }
      if (state.files.some((item) => sameFile(item.file, file))) continue;
      if (state.files.length >= CONFIG.MAX_IMAGES) { skippedLimit += 1; continue; }
      state.files.push({ file, url: URL.createObjectURL(file) });
    }

    renderPreviews();
    updateDropzone();

    const notes = [];
    if (skippedType.length) notes.push(`Only PNG, JPG, WebP or GIF images work. Skipped ${skippedType.join(', ')}.`);
    if (skippedSize.length) notes.push(`Each image must be under ${CONFIG.MAX_IMAGE_MB} MB. Skipped ${skippedSize.join(', ')}.`);
    if (skippedLimit) notes.push(`A tweet has at most ${CONFIG.MAX_IMAGES} photos. Skipped ${skippedLimit} extra.`);

    if (notes.length) {
      els.imageError.textContent = notes.join(' ');
      els.imageError.hidden = false;
    } else {
      clearImageError();
    }
  }

  function hasFiles(event) {
    return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  }

  function initDropzone() {
    els.fileInput.addEventListener('change', () => {
      addFiles(els.fileInput.files);
      els.fileInput.value = '';      // lets the same file be picked again after removal
    });

    ['dragenter', 'dragover'].forEach((type) =>
      els.dropzone.addEventListener(type, (event) => {
        if (!hasFiles(event) || els.fileInput.disabled) return;
        event.preventDefault();
        els.dropzone.classList.add('is-over');
      })
    );
    els.dropzone.addEventListener('dragleave', (event) => {
      if (!els.dropzone.contains(event.relatedTarget)) els.dropzone.classList.remove('is-over');
    });
    els.dropzone.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      els.dropzone.classList.remove('is-over');
      if (!els.fileInput.disabled) addFiles(event.dataTransfer.files);
    });

    // A missed drop would make the browser open the image and leave the page.
    window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', (event) => { if (hasFiles(event)) event.preventDefault(); });

    // Paste a screenshot straight in.
    document.addEventListener('paste', (event) => {
      if (state.mode !== 'pair' || state.busy) return;
      const files = event.clipboardData && event.clipboardData.files;
      if (files && files.length) {
        event.preventDefault();
        addFiles(files);
      }
    });
  }

  function updateCounter() {
    els.counter.textContent =
      `${els.text.value.length.toLocaleString()} / ${CONFIG.MAX_TEXT_CHARS.toLocaleString()}`;
  }

  /* ------------------------------------------------------------------ */
  /* Validation                                                         */
  /* ------------------------------------------------------------------ */
  function normalizeUrl(raw) {
    const value = raw.trim();
    return value && !/^https?:\/\//i.test(value) ? `https://${value}` : value;
  }

  function validate() {
    if (state.mode === 'link') {
      const raw = els.url.value.trim();
      if (!raw) {
        return { ok: false, input: els.url, errorEl: els.urlError, message: 'Paste a tweet link to analyze.' };
      }
      const url = normalizeUrl(raw);
      if (!TWEET_URL_RE.test(url)) {
        return {
          ok: false, input: els.url, errorEl: els.urlError,
          message: 'That doesn’t look like a tweet link. It should look like https://x.com/username/status/1234567890.',
        };
      }
      els.url.value = url;
      return { ok: true, payload: { mode: 'link', url } };
    }

    if (state.mode === 'html') {
      const html = els.html.value.trim();
      if (!html) {
        return { ok: false, input: els.html, errorEl: els.htmlError, message: 'Paste the tweet’s HTML to analyze.' };
      }
      if (!/<[a-z!/][^>]*>/i.test(html)) {
        return {
          ok: false, input: els.html, errorEl: els.htmlError,
          message: 'That doesn’t look like HTML. Paste the embed code or page source, starting with a tag such as <blockquote>.',
        };
      }
      if (html.length > CONFIG.MAX_HTML_CHARS) {
        return {
          ok: false, input: els.html, errorEl: els.htmlError,
          message: `The HTML is too long (limit ${CONFIG.MAX_HTML_CHARS.toLocaleString()} characters). Paste only the tweet’s embed code.`,
        };
      }
      return { ok: true, payload: { mode: 'html', html } };
    }

    const text = els.text.value.trim();
    if (!text) {
      return { ok: false, input: els.text, errorEl: els.textError, message: 'Enter the tweet’s text to analyze.' };
    }
    if (state.files.length === 0) {
      return {
        ok: false, input: els.fileInput, errorEl: els.imageError,
        message: 'Add at least one photo from the tweet. The model reads the image and text together.',
      };
    }
    return { ok: true, payload: { mode: 'pair', text, files: state.files.map((item) => item.file) } };
  }

  /* ------------------------------------------------------------------ */
  /* Calling the model                                                  */
  /* ------------------------------------------------------------------ */
  function extractMessage(body) {
    if (!body || typeof body !== 'object') return '';
    const { detail, error, message } = body;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => (d && (d.msg || d.message)) || '').filter(Boolean).join(' ');
    }
    if (typeof error === 'string') return error;
    if (typeof message === 'string') return message;
    return '';
  }

  async function predict(payload) {
    if (DEMO) return demoPredict(payload);

    const body = new FormData();
    body.append('mode', payload.mode);
    if (payload.mode === 'link') body.append('tweet_url', payload.url);
    if (payload.mode === 'html') body.append('tweet_html', payload.html);
    if (payload.mode === 'pair') {
      body.append('text', payload.text);
      for (const file of payload.files) body.append('images', file, file.name);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG.API_URL, { method: 'POST', body, signal: controller.signal });
      const type = response.headers.get('content-type') || '';
      let data = null;
      if (type.includes('application/json')) {
        try { data = await response.json(); } catch (e) { data = null; }
      }
      if (!response.ok) {
        const fromServer = extractMessage(data);
        if (fromServer) throw new UserError(fromServer);
        const hint = response.status === 404 || response.status === 405
          ? ' Check that API_URL in script.js points to the model’s prediction endpoint.'
          : '';
        throw new UserError(`The server returned an error (${response.status}).${hint}`);
      }
      if (data === null) {
        throw new UserError('The server replied, but not with JSON this page can read. Check the response format described at the top of script.js.');
      }
      return data;
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (error && error.name === 'AbortError') {
        throw new UserError('The model took too long to respond. Try again in a moment. A sleeping Space can need a minute to wake up.');
      }
      throw new UserError('Couldn’t reach the model. Check that the Space is running and that API_URL in script.js is correct.');
    } finally {
      clearTimeout(timer);
    }
  }

  function demoPredict(payload) {
    const seed = [
      payload.mode, payload.url || '', payload.html || '', payload.text || '',
      ...(payload.files || []).map((f) => `${f.name}${f.size}`),
    ].join('|');
    let hash = 2166136261;
    for (const ch of seed) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const unit = ((hash >>> 0) % 10000) / 10000;
    const informative = 0.06 + unit * 0.88;
    return new Promise((resolve) =>
      setTimeout(
        () => resolve({ probabilities: { informative, not_informative: 1 - informative } }),
        1500
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* Reading the response                                               */
  /* ------------------------------------------------------------------ */
  function normalizeLabel(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw)
      .toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    if (s === 'informative') return 'informative';
    if (s === 'not informative' || s === 'non informative' || s === 'noninformative') return 'not_informative';
    return null;
  }

  // Returns { inf, not } as numbers in [0, 1] that sum to 1, or null.
  function probsFrom(raw) {
    if (Array.isArray(raw) && raw.length === 2) raw = { not_informative: raw[0], informative: raw[1] };
    if (!raw || typeof raw !== 'object') return null;

    let inf = null;
    let not = null;
    for (const [key, value] of Object.entries(raw)) {
      const label = normalizeLabel(key);
      const n = Number(value);
      if (!label || !Number.isFinite(n) || n < 0) continue;
      if (label === 'informative') inf = n; else not = n;
    }
    if (inf === null && not === null) return null;

    const scale = Math.max(inf || 0, not || 0) > 1.0001 ? 100 : 1;   // accept percentages too
    if (inf !== null) inf /= scale;
    if (not !== null) not /= scale;
    if (inf === null) inf = clamp(1 - not, 0, 1);
    if (not === null) not = clamp(1 - inf, 0, 1);

    const total = inf + not;
    if (total <= 0) return null;
    return { inf: inf / total, not: not / total };
  }

  function parseOne(item) {
    if (!item || typeof item !== 'object') return null;
    let label = normalizeLabel(item.label !== undefined ? item.label : item.prediction);
    let probs = probsFrom(
      item.probabilities !== undefined ? item.probabilities
        : item.probs !== undefined ? item.probs : item.scores
    );
    if (!probs) {
      let confidence = Number(item.confidence !== undefined ? item.confidence : item.score);
      if (label && Number.isFinite(confidence) && confidence >= 0) {
        if (confidence > 1.0001) confidence /= 100;
        confidence = clamp(confidence, 0, 1);
        probs = label === 'informative'
          ? { inf: confidence, not: 1 - confidence }
          : { inf: 1 - confidence, not: confidence };
      }
    }
    if (!probs) return null;
    // Derive the label from the numbers so the scale and the verdict can never disagree.
    label = probs.inf >= probs.not ? 'informative' : 'not_informative';
    return { label, probs };
  }

  function safeImageSrc(value) {
    const src = typeof value === 'string' ? value : value && value.url;
    if (typeof src !== 'string') return null;
    return /^https?:\/\//i.test(src) || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src) ? src : null;
  }

  function parseResult(data) {
    const result = parseOne(data);
    if (!result) {
      throw new UserError('The server replied, but not in a format this page understands. See the response format at the top of script.js.');
    }
    const tweet = data && typeof data.tweet === 'object' && data.tweet ? data.tweet : {};
    result.tweetText = typeof tweet.text === 'string' ? tweet.text.trim() : '';
    result.tweetImages = Array.isArray(tweet.images) ? tweet.images.map(safeImageSrc).filter(Boolean) : [];
    result.perImage = Array.isArray(data.per_image) ? data.per_image.map(parseOne) : null;
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Readout                                                            */
  /* ------------------------------------------------------------------ */
  function setBusy(busy) {
    state.busy = busy;
    els.submit.setAttribute('aria-busy', String(busy));
    els.submitLabel.textContent = busy ? 'Analyzing…' : 'Analyze tweet';
    els.clear.disabled = busy;
  }

  function resetEcho() {
    revokeAll(state.resultUrls);
    els.echo.hidden = true;
    els.echoQuote.hidden = true;
    els.echoText.textContent = '';
    els.echoImages.hidden = true;
    els.echoImages.replaceChildren();
    els.meta.hidden = true;
    els.meta.textContent = '';
    els.meta.classList.remove('is-demo');
  }

  function resetReadout() {
    clearTimeout(state.slowTimer);
    resetEcho();
    els.readout.style.setProperty('--pos', '50');
    els.readout.dataset.state = 'idle';
    delete els.verdict.dataset.label;
    els.verdict.textContent = 'Waiting for a tweet';
    els.verdictNote.textContent = 'Add a tweet above and press Analyze tweet. The result lands on the scale below.';
    els.markerValue.textContent = '';
    els.pInf.textContent = '–';
    els.pNot.textContent = '–';
    els.numInf.dataset.pick = 'false';
    els.numNot.dataset.pick = 'false';
    els.status.textContent = '';
  }

  function setReadoutLoading() {
    resetEcho();
    delete els.verdict.dataset.label;
    els.verdict.textContent = 'Analyzing…';
    els.verdictNote.textContent = 'Reading the text and images together.';
    els.markerValue.textContent = '';
    els.pInf.textContent = '–';
    els.pNot.textContent = '–';
    els.numInf.dataset.pick = 'false';
    els.numNot.dataset.pick = 'false';
    els.readout.dataset.state = 'loading';
    els.status.textContent = 'Analyzing the tweet.';
    clearTimeout(state.slowTimer);
    state.slowTimer = setTimeout(() => {
      els.verdictNote.textContent = 'Still working. If the model was asleep, it can take a minute to start.';
    }, CONFIG.SLOW_NOTICE_MS);
  }

  // Start the slide from wherever the sweeping marker currently is.
  function settleMarker(finalPos) {
    const track = els.track.getBoundingClientRect();
    const marker = els.marker.getBoundingClientRect();
    let current = 50;
    if (track.width > 0) {
      current = clamp(((marker.left + marker.width / 2 - track.left) / track.width) * 100, 0, 100);
    }
    els.readout.style.setProperty('--pos', current.toFixed(2));
    els.readout.dataset.state = 'done';
    void els.marker.offsetWidth;            // commit the start position before animating
    requestAnimationFrame(() => els.readout.style.setProperty('--pos', finalPos.toFixed(2)));
  }

  function renderEcho(result, payload) {
    let text = result.tweetText;
    let images = result.tweetImages;

    if (payload.mode === 'pair') {
      if (!text) text = payload.text;
      if (!images.length) {
        images = payload.files.map((file) => {
          const url = URL.createObjectURL(file);
          state.resultUrls.push(url);
          return url;
        });
      }
    }

    els.echoText.textContent = text;
    els.echoQuote.hidden = !text;

    const perImage = result.perImage && result.perImage.length === images.length ? result.perImage : null;
    els.echoImages.replaceChildren(
      ...images.map((src, index) => {
        const figure = h(
          'figure',
          { class: 'echo-fig' },
          h('img', { src, alt: `Photo ${index + 1} from the tweet`, decoding: 'async', referrerpolicy: 'no-referrer' })
        );
        const one = perImage && perImage[index];
        if (one) {
          const p = one.label === 'informative' ? one.probs.inf : one.probs.not;
          figure.append(h('figcaption', { text: `${LABEL_NAMES[one.label]}, ${fmtPct(p, 0)}` }));
        }
        return figure;
      })
    );
    els.echoImages.hidden = images.length === 0;
    els.echo.hidden = !text && images.length === 0;
  }

  function showResult(result, payload, elapsedMs) {
    clearTimeout(state.slowTimer);
    const informative = result.label === 'informative';
    const confidence = informative ? result.probs.inf : result.probs.not;
    const name = LABEL_NAMES[result.label];

    els.verdict.textContent = name;
    els.verdict.dataset.label = result.label;
    els.verdictNote.textContent =
      `The model is ${fmtPct(confidence)} sure this tweet is ${name.toLowerCase()}.` +
      (confidence < CLOSE_CALL ? ' That is a close call, so check this one by hand.' : '');
    els.pInf.textContent = fmtPct(result.probs.inf);
    els.pNot.textContent = fmtPct(result.probs.not);
    els.numInf.dataset.pick = String(informative);
    els.numNot.dataset.pick = String(!informative);
    els.markerValue.textContent = fmtPct(result.probs.inf, 0);

    renderEcho(result, payload);

    els.meta.textContent = DEMO
      ? 'Demo mode: this result is simulated and did not come from the model.'
      : `Analyzed in ${(elapsedMs / 1000).toFixed(1)} s.`;
    els.meta.classList.toggle('is-demo', DEMO);
    els.meta.hidden = false;

    settleMarker(result.probs.inf * 100);
    els.status.textContent = `Result: ${name}, ${fmtPct(confidence)} sure.`;

    els.readout.focus({ preventScroll: true });
    els.readout.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  /* ------------------------------------------------------------------ */
  /* Submit and clear                                                   */
  /* ------------------------------------------------------------------ */
  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    clearErrors();

    const check = validate();
    if (!check.ok) {
      showFieldError(check.input, check.errorEl, check.message);
      return;
    }

    setBusy(true);
    setReadoutLoading();
    const started = performance.now();
    try {
      const data = await predict(check.payload);
      const result = parseResult(data);
      showResult(result, check.payload, performance.now() - started);
    } catch (error) {
      resetReadout();
      showFormError(
        error instanceof UserError
          ? error.message
          : 'Something went wrong while showing the result. Try again.'
      );
    } finally {
      clearTimeout(state.slowTimer);
      setBusy(false);
    }
  }

  function onClear() {
    if (state.busy) return;
    els.url.value = '';
    els.html.value = '';
    els.text.value = '';
    updateCounter();
    for (const item of state.files) URL.revokeObjectURL(item.url);
    state.files = [];
    renderPreviews();
    updateDropzone();
    clearErrors();
    resetReadout();
    const first = { link: els.url, html: els.html, pair: els.text }[state.mode];
    if (first) first.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */
  function init() {
    els.text.maxLength = CONFIG.MAX_TEXT_CHARS;
    els.imageHelp.textContent =
      `Up to ${CONFIG.MAX_IMAGES} images, ${CONFIG.MAX_IMAGE_MB} MB each. PNG, JPG, WebP or GIF.`;
    els.demoPill.hidden = !DEMO;

    initTheme();
    initDropzone();

    for (const tab of els.tabs) tab.addEventListener('click', () => selectMode(tab.dataset.mode));
    els.tablist.addEventListener('keydown', onTabKeydown);

    for (const [input, errorEl] of FIELD_PAIRS()) {
      input.addEventListener('input', () => {
        errorEl.hidden = true;
        input.removeAttribute('aria-invalid');
      });
    }
    els.text.addEventListener('input', updateCounter);

    els.form.addEventListener('submit', onSubmit);
    els.clear.addEventListener('click', onClear);

    selectMode('link');
    updateCounter();
    updateDropzone();
    resetReadout();
  }

  init();
})();