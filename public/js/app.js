/* ============================================================================
   NEONWAVE — Client Application
   ==========================================================================*/
'use strict';

(() => {
  /* ------------------------------------------------------------------------
     Утиліти
  ------------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const escapeHtml = (str) =>
    String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function toast(message, type = '') {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .35s, transform .35s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 380);
    }, 3200);
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...(options.headers || {}) }
        : options.headers || {},
      ...options,
      body:
        options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body,
    });

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------------------
     Стан
  ------------------------------------------------------------------------ */

  const state = {
    user: null,
    tracks: [],
    queue: [],
    currentIndex: -1,
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    activeTab: 'all',
    comments: [],
    room: null,
    roomId: null,
    isHost: false,
    applyingRemote: false,
    progressTimer: null,
  };

  const socket = typeof io === 'function' ? io({ withCredentials: true }) : null;

  /* ------------------------------------------------------------------------
     АУДІО-РУШІЙ (crossfade + Web Audio API)
  ------------------------------------------------------------------------ */

  const elA = $('#audioA');
  const elB = $('#audioB');

  const audio = {
    ctx: null,
    analyser: null,
    masterGain: null,
    sources: new WeakMap(),
    active: elA,
    idle: elB,
    fadeTimer: null,
  };

  function ensureAudioGraph() {
    if (audio.ctx) return;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.masterGain = audio.ctx.createGain();
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 256;
      audio.analyser.smoothingTimeConstant = 0.82;

      for (const el of [elA, elB]) {
        const src = audio.ctx.createMediaElementSource(el);
        src.connect(audio.masterGain);
        audio.sources.set(el, src);
      }

      audio.masterGain.connect(audio.analyser);
      audio.analyser.connect(audio.ctx.destination);
    } catch (err) {
      console.warn('[audio] Web Audio API недоступний:', err.message);
    }
  }

  function resumeAudioCtx() {
    if (audio.ctx && audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------
     ВІЗУАЛІЗАТОР
  ------------------------------------------------------------------------ */

  const canvas = $('#visualizer');
  const ctx2d = canvas.getContext('2d');
  let vizRaf = null;
  let vizData = null;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }

  function drawVisualizer() {
    vizRaf = requestAnimationFrame(drawVisualizer);

    const w = canvas.width;
    const h = canvas.height;

    ctx2d.clearRect(0, 0, w, h);

    if (!audio.analyser || !state.currentTrack || isPaused()) return;

    if (!vizData || vizData.length !== audio.analyser.frequencyBinCount) {
      vizData = new Uint8Array(audio.analyser.frequencyBinCount);
    }

    audio.analyser.getByteFrequencyData(vizData);

    const bars = 64;
    const step = Math.floor(vizData.length / bars);
    const barW = w / bars;

    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += vizData[i * step + j];
      const v = sum / step / 255;

      const barH = Math.pow(v, 1.35) * h * 0.9 + 2;
      const x = i * barW;
      const y = h - barH;

      const grad = ctx2d.createLinearGradient(0, h, 0, y);
      grad.addColorStop(0, 'rgba(0,229,255,0.85)');
      grad.addColorStop(0.55, 'rgba(177,76,255,0.7)');
      grad.addColorStop(1, 'rgba(255,61,154,0.35)');

      ctx2d.fillStyle = grad;
      ctx2d.beginPath();
      const r = Math.min(barW / 2 - 1, 3);
      const bw = Math.max(1, barW - 2);
      roundRect(ctx2d, x + 1, y, bw, barH, r);
      ctx2d.fill();
    }
  }

  function roundRect(c, x, y, w, h, r) {
    if (h < 0) h = 0;
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* ------------------------------------------------------------------------
     AMBIENT BACKGROUND (extract colors from cover)
  ------------------------------------------------------------------------ */

  const colorCache = new Map();

  function extractPalette(src) {
    if (colorCache.has(src)) return Promise.resolve(colorCache.get(src));

    return new Promise((resolve) => {
      const fallback = ['rgba(0,229,255,.32)', 'rgba(177,76,255,.30)', 'rgba(255,61,154,.22)'];

      if (!src) return resolve(fallback);

      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        try {
          const size = 48;
          const c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, size, size);

          const data = g.getImageData(0, 0, size, size).data;
          const buckets = new Map();

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const gg = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (a < 128) continue;

            const max = Math.max(r, gg, b);
            const min = Math.min(r, gg, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;

            if (lum < 0.08 || lum > 0.96) continue;

            const key = `${r >> 4}-${gg >> 4}-${b >> 4}`;
            const entry = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, score: 0 };
            entry.r += r;
            entry.g += gg;
            entry.b += b;
            entry.n += 1;
            entry.score += sat * 1.6 + (1 - Math.abs(lum - 0.55)) * 0.7;
            buckets.set(key, entry);
          }

          const list = Array.from(buckets.values())
            .filter((e) => e.n > 2)
            .sort((x, y) => y.score - x.score)
            .slice(0, 3)
            .map((e) => [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);

          if (list.length === 0) return resolve(fallback);

          while (list.length < 3) list.push(list[list.length - 1]);

          const out = list.map((c2, i) => `rgba(${c2[0]},${c2[1]},${c2[2]},${0.34 - i * 0.06})`);
          colorCache.set(src, out);
          resolve(out);
        } catch {
          resolve(fallback);
        }
      };

      img.onerror = () => resolve(fallback);
      img.src = src;
    });
  }

  async function applyAmbient(src) {
    const [c1, c2, c3] = await extractPalette(src);
    const ambient = $('#ambient');
    ambient.style.background = `
      radial-gradient(45% 45% at 22% 25%, ${c1}, transparent 65%),
      radial-gradient(50% 50% at 78% 30%, ${c2}, transparent 68%),
      radial-gradient(55% 55% at 50% 85%, ${c3}, transparent 70%)
    `;
  }

  /* ------------------------------------------------------------------------
     AUTH UI
  ------------------------------------------------------------------------ */

  async function loadUser() {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
    } catch {
      state.user = null;
    }
    renderAuth();
  }

  function renderAuth() {
    const loginBtn = $('#loginBtn');
    const chip = $('#userChip');
    const adminLink = $('#adminLink');
    const tabLikes = $('#tabLikes');
    const tabHistory = $('#tabHistory');

    if (state.user) {
      loginBtn.hidden = true;
      chip.hidden = false;
      $('#userName').textContent = state.user.username;
      const av = $('#userAvatar');
      av.textContent = state.user.username.charAt(0).toUpperCase();
      av.style.background = state.user.avatar_color || '#00e5ff';

      adminLink.hidden = state.user.role !== 'admin';
      tabLikes.hidden = false;
      tabHistory.hidden = false;
    } else {
      loginBtn.hidden = false;
      chip.hidden = true;
      adminLink.hidden = true;
      tabLikes.hidden = true;
      tabHistory.hidden = true;
      if (state.activeTab !== 'all') switchTab('all');
    }
  }

  let authMode = 'login';

  function openAuth(mode) {
    authMode = mode || 'login';
    $('#authTitle').textContent = authMode === 'login' ? 'Вхід' : 'Реєстрація';
    $('#authSubmit').textContent = authMode === 'login' ? 'Увійти' : 'Створити акаунт';
    $('#switchLine').innerHTML =
      authMode === 'login'
        ? 'Немає акаунту? <a href="#" id="switchAuth">Зареєструватися</a>'
        : 'Вже маєте акаунт? <a href="#" id="switchAuth">Увійти</a>';
    $('#authError').hidden = true;
    $('#authForm').reset();
    openModal('authModal');
    bindSwitchAuth();
  }

  function bindSwitchAuth() {
    const el = $('#switchAuth');
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openAuth(authMode === 'login' ? 'register' : 'login');
    });
  }

  /* ------------------------------------------------------------------------
     MODALS
  ------------------------------------------------------------------------ */

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = true;
    const anyOpen = $$('.modal').some((x) => !x.hidden);
    if (!anyOpen) document.body.style.overflow = '';
  }

  function closeAllModals() {
    $$('.modal').forEach((m) => (m.hidden = true));
    document.body.style.overflow = '';
  }

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      const modal = closer.closest('.modal');
      if (modal) closeModal(modal.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  /* ------------------------------------------------------------------------
     PLAYER — ядро
  ------------------------------------------------------------------------ */

  function currentTrack() {
    return state.queue[state.currentIndex] || null;
  }

  function isPaused() {
    return audio.active.paused;
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = currentTrack();
    if (!t) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist || 'AI',
        album: 'NEONWAVE',
        artwork: t.cover_url
          ? [
              { src: t.cover_url, sizes: '96x96', type: 'image/jpeg' },
              { src: t.cover_url, sizes: '192x192', type: 'image/jpeg' },
              { src: t.cover_url, sizes: '512x512', type: 'image/jpeg' },
            ]
          : [{ src: '/icons/icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
      });

      navigator.mediaSession.setActionHandler('play', () => play());
      navigator.mediaSession.setActionHandler('pause', () => pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
      navigator.mediaSession.setActionHandler('seekbackward', (d) => {
        audio.active.currentTime = Math.max(0, audio.active.currentTime - (d.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (d) => {
        audio.active.currentTime = Math.min(
          audio.active.duration || 1e9,
          audio.active.currentTime + (d.seekOffset || 10)
        );
      });
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if (typeof d.seekTime === 'number') audio.active.currentTime = d.seekTime;
      });
    } catch {
      /* ignore */
    }
  }

  function crossfadeTo(newEl, durationMs = 700) {
    ensureAudioGraph();
    resumeAudioCtx();

    const oldEl = audio.active;
    const fromVolume = oldEl.volume;
    const targetVolume = parseFloat($('#volume').value) || 1;

    newEl.volume = 0;
    audio.active = newEl;
    audio.idle = oldEl;

    if (audio.fadeTimer) cancelAnimationFrame(audio.fadeTimer);

    const start = performance.now();

    function step(now) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = t * t * (3 - 2 * t);

      newEl.volume = Math.min(1, targetVolume * eased);
      oldEl.volume = Math.max(0, fromVolume * (1 - eased));

      if (t < 1) {
        audio.fadeTimer = requestAnimationFrame(step);
      } else {
        oldEl.pause();
        try { oldEl.currentTime = 0; } catch { /* ignore */ }
        oldEl.volume = targetVolume;
        newEl.volume = targetVolume;
      }
    }

    audio.fadeTimer = requestAnimationFrame(step);
  }

  async function loadTrack(track, opts = {}) {
    if (!track) return;

    state.currentIndex = state.queue.findIndex((t) => t.id === track.id);
    const el = audio.idle;

    el.src = track.audio_url;
    el.load();

    const volume = parseFloat($('#volume').value) || 1;

    try {
      await el.play();
    } catch (err) {
      // Автовідтворення може бути заблоковане — показуємо стан "пауза"
      console.warn('[player] play() заблоковано:', err.message);
      renderPlayer();
      return;
    }

    crossfadeTo(el, 700);
    onTrackChanged(track, opts);
  }

  function onTrackChanged(track, opts = {}) {
    renderPlayer();
    renderTrackList();
    applyAmbient(track.cover_url);
    updateMediaSession();
    renderComments(track.id);

    if (!opts.fromRemote) {
      api(`/api/tracks/${track.id}/play`, { method: 'POST' }).catch(() => {});
      api('/api/player/event', {
        method: 'POST',
        body: { event: 'track_change', track_id: track.id, position: 0 },
      }).catch(() => {});

      if (state.isHost && state.roomId && socket) {
        socket.emit('room:control', { action: 'track', trackId: track.id });
      }
    }
  }

  function play() {
    ensureAudioGraph();
    resumeAudioCtx();

    if (!currentTrack()) {
      if (state.queue.length) return playTrackAt(0);
      return;
    }

    audio.active.play().catch(() => {});

    api('/api/player/event', {
      method: 'POST',
      body: {
        event: 'play',
        track_id: currentTrack().id,
        position: audio.active.currentTime,
      },
    }).catch(() => {});

    if (state.isHost && state.roomId && socket) {
      socket.emit('room:control', {
        action: 'play',
        position: audio.active.currentTime,
      });
    }
  }

  function pause() {
    audio.active.pause();

    api('/api/player/event', {
      method: 'POST',
      body: {
        event: 'pause',
        track_id: currentTrack() ? currentTrack().id : null,
        position: audio.active.currentTime,
      },
    }).catch(() => {});

    if (state.isHost && state.roomId && socket) {
      socket.emit('room:control', { action: 'pause', position: audio.active.currentTime });
    }
  }

  function togglePlay() {
    if (isPaused()) play();
    else pause();
  }

  function playTrackAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    const track = state.queue[index];
    const el = audio.active;

    if (currentTrack() && currentTrack().id === track.id && !el.paused) {
      pause();
      return;
    }

    if (currentTrack() && currentTrack().id === track.id) {
      play();
      return;
    }

    loadTrack(track);
  }

  function next(auto = false) {
    if (state.repeat === 'one' && auto) {
      audio.active.currentTime = 0;
      play();
      return;
    }

    if (state.queue.length === 0) return;

    let idx;
    if (state.shuffle) {
      idx = Math.floor(Math.random() * state.queue.length);
      if (state.queue.length > 1 && idx === state.currentIndex) {
        idx = (idx + 1) % state.queue.length;
      }
    } else {
      idx = state.currentIndex + 1;
      if (idx >= state.queue.length) {
        if (state.repeat === 'all' || !auto) idx = 0;
        else {
          pause();
          return;
        }
      }
    }

    playTrackAt(idx);
  }

  function prev() {
    if (state.queue.length === 0) return;
    if (audio.active.currentTime > 4) {
      audio.active.currentTime = 0;
      return;
    }
    let idx = state.currentIndex - 1;
    if (idx < 0) idx = state.queue.length - 1;
    playTrackAt(idx);
  }

  /* ------------------------------------------------------------------------
     ПРОГРЕС / SEEK
  ------------------------------------------------------------------------ */

  function updateProgress() {
    const el = audio.active;
    const dur = el.duration || (currentTrack() ? currentTrack().duration : 0) || 0;
    const cur = el.currentTime || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;

    $('#seekFill').style.width = `${pct}%`;
    $('#progressFill').style.width = `${pct}%`;
    $('#seekHandle').style.left = `${pct}%`;
    $('#curTime').textContent = fmtTime(cur);
    $('#durTime').textContent = fmtTime(dur);

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: el.playbackRate,
          position: Math.min(cur, dur),
        });
      } catch {
        /* ignore */
      }
    }

    renderSeekMarkers(dur);
  }

  function seekToFraction(fraction) {
    const el = audio.active;
    const dur = el.duration || 0;
    if (!dur) return;

    const t = Math.max(0, Math.min(1, fraction)) * dur;
    el.currentTime = t;

    if (state.isHost && state.roomId && socket) {
      socket.emit('room:control', { action: 'seek', position: t });
    }

    api('/api/player/event', {
      method: 'POST',
      body: { event: 'seek', track_id: currentTrack() ? currentTrack().id : null, position: t },
    }).catch(() => {});
  }

  function bindSeek(container) {
    let dragging = false;

    const fractionFromEvent = (e) => {
      const rect = container.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      return Math.max(0, Math.min(1, x / rect.width));
    };

    const start = (e) => {
      dragging = true;
      container.setPointerCapture && container.setPointerCapture(e.pointerId);
      seekToFraction(fractionFromEvent(e));
    };

    const move = (e) => {
      if (!dragging) return;
      seekToFraction(fractionFromEvent(e));
    };

    const end = () => {
      dragging = false;
    };

    container.addEventListener('pointerdown', start);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
    container.addEventListener('pointerleave', end);
  }

  /* ------------------------------------------------------------------------
     КОМЕНТАРІ НА ТАЙМЛАЙНІ
  ------------------------------------------------------------------------ */

  function renderSeekMarkers(duration) {
    const wrap = $('#seekMarkers');
    const wrapTop = $('#progressMarkers');
    if (!duration || !state.comments.length) {
      wrap.innerHTML = '';
      wrapTop.innerHTML = '';
      return;
    }

    const html = state.comments
      .map((c) => {
        const pct = Math.min(100, (c.time_sec / duration) * 100);
        return `<div class="p-marker" style="left:${pct}%" data-time="${c.time_sec}" title="${escapeHtml(
          c.username
        )}: ${escapeHtml(c.body)}"></div>`;
      })
      .join('');

    wrap.innerHTML = html;
    wrapTop.innerHTML = html;

    wrap.querySelectorAll('.p-marker').forEach((m) => {
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        seekToFraction(Number(m.dataset.time) / duration);
      });
    });
  }

  function renderComments(trackId) {
    const list = $('#commentList');
    if (!list) return;

    if (!state.comments.length) {
      list.innerHTML = '<div class="empty-state" style="padding:30px 0"><p>Ще немає коментарів. Будьте першим!</p></div>';
      return;
    }

    list.innerHTML = state.comments
      .map((c) => {
        const canDelete =
          state.user && (state.user.id === c.user_id || state.user.role === 'admin');
        return `
          <div class="comment-item" data-time="${c.time_sec}">
            <div class="comment-avatar" style="background:${escapeHtml(c.avatar_color || '#00e5ff')}">
              ${escapeHtml((c.username || '?').charAt(0).toUpperCase())}
            </div>
            <div class="comment-body">
              <div class="comment-head">
                <span class="comment-user">${escapeHtml(c.username)}</span>
                <span class="comment-time">${fmtTime(c.time_sec)}</span>
              </div>
              <div class="comment-text">${escapeHtml(c.body)}</div>
            </div>
            ${canDelete ? `<button class="comment-del" data-id="${c.id}" title="Видалити">&times;</button>` : ''}
          </div>`;
      })
      .join('');

    list.querySelectorAll('.comment-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.comment-del')) return;
        const t = Number(item.dataset.time);
        const dur = audio.active.duration || 0;
        if (dur) seekToFraction(t / dur);
        closeModal('commentsModal');
      });
    });

    list.querySelectorAll('.comment-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/comments/${btn.dataset.id}`, { method: 'DELETE' });
          state.comments = state.comments.filter((c) => c.id !== Number(btn.dataset.id));
          renderComments(trackId);
          renderSeekMarkers(audio.active.duration || 0);
        } catch {
          toast('Не вдалося видалити коментар', 'err');
        }
      });
    });
  }

  async function loadComments(trackId) {
    if (!trackId) {
      state.comments = [];
      return;
    }
    try {
      const data = await api(`/api/tracks/${trackId}/comments`);
      state.comments = data.comments || [];
    } catch {
      state.comments = [];
    }
    renderComments(trackId);
    renderSeekMarkers(audio.active.duration || 0);
  }

  /* ------------------------------------------------------------------------
     РЕНДЕР СПИСКУ ТРЕКІВ
  ------------------------------------------------------------------------ */

  function renderTrackList() {
    const list = $('#trackList');
    const empty = $('#emptyState');
    const skeleton = $('#skeletonList');

    skeleton.hidden = true;

    if (!state.tracks.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    const cur = currentTrack();

    list.innerHTML = state.tracks
      .map((t, i) => {
        const isPlaying = cur && cur.id === t.id;
        return `
          <div class="track-row ${isPlaying ? 'playing' : ''}" data-id="${t.id}" data-index="${i}">
            <div class="track-index">${isPlaying ? '▶' : i + 1}</div>
            <img class="track-cover" loading="lazy" src="${t.cover_url || '/icons/icon.svg'}" alt="" />
            <div class="track-info">
              <div class="track-title">${escapeHtml(t.title)}</div>
              <div class="track-meta">${escapeHtml(t.artist || 'AI')}${t.genre ? ' • ' + escapeHtml(t.genre) : ''} • ${t.plays} прослуховувань</div>
              ${
                t.tags && t.tags.length
                  ? `<div class="track-tags">${t.tags.slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`
                  : ''
              }
            </div>
            <div class="track-actions">
              <button class="track-like ${t.liked ? 'liked' : ''}" data-like="${t.id}">
                <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 21s-7.5-4.6-9.3-9A5.6 5.6 0 0 1 12 5.6 5.6 5.6 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9Z"/></svg>
                <span>${t.likes || 0}</span>
              </button>
              <div class="track-dur">${fmtTime(t.duration)}</div>
            </div>
          </div>`;
      })
      .join('');

    list.querySelectorAll('.track-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.track-like')) return;
        const id = Number(row.dataset.id);
        const track = state.tracks.find((t) => t.id === id);
        if (!track) return;

        state.queue = state.tracks.slice();
        const idx = state.queue.findIndex((t) => t.id === id);

        if (currentTrack() && currentTrack().id === id) {
          togglePlay();
          return;
        }

        state.currentIndex = idx;
        loadTrack(track);
      });
    });

    list.querySelectorAll('.track-like').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (!state.user) {
          openAuth('login');
          return;
        }

        const id = Number(btn.dataset.like);
        const track = state.tracks.find((t) => t.id === id);
        if (!track) return;

        const method = track.liked ? 'DELETE' : 'POST';

        try {
          const res = await api(`/api/tracks/${id}/like`, { method });
          track.liked = res.liked;
          track.likes = res.likes;
          btn.classList.toggle('liked', res.liked);
          btn.querySelector('span').textContent = res.likes;
          if (currentTrack() && currentTrack().id === id) {
            $('#likeBtn').classList.toggle('liked', res.liked);
          }
        } catch {
          toast('Помилка', 'err');
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     РЕНДЕР ПЛЕЄРА
  ------------------------------------------------------------------------ */

  function renderPlayer() {
    const t = currentTrack();
    const player = $('#player');

    if (!t) {
      $('#pTitle').textContent = 'Оберіть трек';
      $('#pArtist').textContent = '—';
      return;
    }

    $('#pTitle').textContent = t.title;
    $('#pArtist').textContent = `${t.artist || 'AI'}${t.genre ? ' • ' + t.genre : ''}`;

    const cover = $('#pCover');
    cover.src = t.cover_url || '/icons/icon.svg';

    $('#likeBtn').classList.toggle('liked', !!t.liked);

    const paused = audio.active.paused;
    player.classList.toggle('is-playing', !paused);
    $('.i-play').hidden = !paused;
    $('.i-pause').hidden = paused;
  }

  function renderQueueModal() {
    const list = $('#queueList');
    const cur = currentTrack();

    list.innerHTML = state.queue
      .map(
        (t) => `
        <div class="queue-item ${cur && cur.id === t.id ? 'current' : ''}" data-id="${t.id}">
          <img src="${t.cover_url || '/icons/icon.svg'}" alt="" />
          <div class="queue-item-info">
            <div class="queue-item-title">${escapeHtml(t.title)}</div>
            <div class="queue-item-artist">${escapeHtml(t.artist || 'AI')} • ${fmtTime(t.duration)}</div>
          </div>
        </div>`
      )
      .join('');

    list.querySelectorAll('.queue-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = Number(item.dataset.id);
        const idx = state.queue.findIndex((t) => t.id === id);
        if (idx >= 0) {
          closeModal('queueModal');
          playTrackAt(idx);
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     ЗАВАНТАЖЕННЯ ТРЕКІВ З API
  ------------------------------------------------------------------------ */

  async function loadTracks(tab = 'all') {
    $('#skeletonList').hidden = false;
    $('#trackList').innerHTML = '';
    $('#emptyState').hidden = true;

    try {
      let url = '/api/tracks';
      if (tab === 'likes') url = '/api/me/likes';
      if (tab === 'history') url = '/api/me/history';

      const data = await api(url);
      state.tracks = data.tracks || [];

      if (tab === 'all') {
        state.queue = state.tracks.slice();
        if (state.currentIndex < 0 && state.queue.length) state.currentIndex = -1;
      }

      renderTrackList();
    } catch (err) {
      if (err.status === 401) {
        switchTab('all');
        return;
      }
      toast('Не вдалося завантажити треки', 'err');
      state.tracks = [];
      renderTrackList();
    } finally {
      $('#skeletonList').hidden = true;
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    loadTracks(tab);
  }

  /* ------------------------------------------------------------------------
     LIVE ROOM
  ------------------------------------------------------------------------ */

  function renderRoom(room) {
    state.room = room;
    state.isHost = socket && room && room.hostId === socket.id;

    $('#roomStart').hidden = true;
    $('#roomActive').hidden = false;

    $('#roomNameLabel').textContent = room.name;
    $('#roomHostLabel').textContent = room.hostName;

    $('#roomMembers').innerHTML = room.members
      .map(
        (m) =>
          `<span class="member-chip ${m.id === room.hostId ? 'host' : ''}">${escapeHtml(m.username)}</span>`
      )
      .join('');

    const chat = $('#roomChat');
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;

    chat.innerHTML = room.chat
      .map((m) =>
        m.system
          ? `<div class="chat-msg sys">${escapeHtml(m.text)}</div>`
          : `<div class="chat-msg"><b>${escapeHtml(m.username)}:</b> ${escapeHtml(m.text)}</div>`
      )
      .join('');

    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  }

  function applyRemoteSync(room) {
    if (!room || !room.state) return;
    const { trackId, playing, position } = room.state;

    if (trackId == null) return;

    const track = state.tracks.find((t) => t.id === trackId) ||
      state.queue.find((t) => t.id === trackId);

    if (!track) {
      // трек відсутній у локальному списку — підтягуємо індивідуально
      api(`/api/tracks/${trackId}`)
        .then((d) => {
          if (d && d.track) {
            state.queue = state.queue.concat([d.track]);
            applyTrackFromRoom(d.track, playing, position);
          }
        })
        .catch(() => {});
      return;
    }

    applyTrackFromRoom(track, playing, position);
  }

  function applyTrackFromRoom(track, playing, position) {
    const cur = currentTrack();

    state.applyingRemote = true;

    const apply = () => {
      const el = audio.active;
      const dur = el.duration || track.duration || 0;
      const target = Math.max(0, Math.min(position, dur || position));

      if (Math.abs(el.currentTime - target) > 1.5) {
        try { el.currentTime = target; } catch { /* ignore */ }
      }

      if (playing && el.paused) {
        ensureAudioGraph();
        resumeAudioCtx();
        el.play().catch(() => {});
      } else if (!playing && !el.paused) {
        el.pause();
      }

      renderPlayer();
      state.applyingRemote = false;
    };

    if (!cur || cur.id !== track.id) {
      const idx = state.queue.findIndex((t) => t.id === track.id);
      if (idx >= 0) state.currentIndex = idx;
      else {
        state.queue.push(track);
        state.currentIndex = state.queue.length - 1;
      }

      const el = audio.idle;
      el.src = track.audio_url;
      el.load();

      const onReady = () => {
        el.removeEventListener('loadedmetadata', onReady);
        if (playing) {
          el.play().then(() => {
            crossfadeTo(el, 400);
            onTrackChanged(track, { fromRemote: true });
            apply();
          }).catch(() => {
            onTrackChanged(track, { fromRemote: true });
            apply();
          });
        } else {
          audio.active = el;
          audio.idle = el === elA ? elB : elA;
          onTrackChanged(track, { fromRemote: true });
          apply();
        }
      };

      el.addEventListener('loadedmetadata', onReady);
    } else {
      apply();
    }
  }

  function setupSocket() {
    if (!socket) return;

    socket.on('connect', () => {
      if (state.roomId) {
        socket.emit('room:join', {
          roomId: state.roomId,
          username: state.user ? state.user.username : 'Гість',
        });
      }
    });

    socket.on('room:update', (room) => {
      if (room.id === state.roomId) renderRoom(room);
    });

    socket.on('room:sync', (room) => {
      if (room.id !== state.roomId) return;
      renderRoom(room);
      if (!state.isHost) applyRemoteSync(room);
    });

    socket.on('room:chat', (message) => {
      if (!state.room) return;
      state.room.chat.push(message);
      renderRoom(state.room);
    });

    socket.on('room:system', (payload) => {
      if (!state.room) return;
      state.room.chat.push({ system: true, text: payload.text, ts: payload.ts });
      renderRoom(state.room);
    });

    socket.on('room:reaction', (payload) => {
      spawnReaction(payload.emoji);
    });

    socket.on('room:error', (payload) => {
      toast(`Кімната: ${payload.error}`, 'err');
    });

    // Глобальні події (для синхронізації списків)
    socket.on('track:new', () => {
      if (state.activeTab === 'all') loadTracks('all');
    });
    socket.on('track:update', () => {
      if (state.activeTab === 'all') loadTracks('all');
    });
    socket.on('track:delete', ({ id }) => {
      state.tracks = state.tracks.filter((t) => t.id !== id);
      state.queue = state.queue.filter((t) => t.id !== id);
      renderTrackList();
    });
    socket.on('comment:new', (comment) => {
      const cur = currentTrack();
      if (cur && comment.track_id === cur.id) {
        if (!state.comments.some((c) => c.id === comment.id)) {
          state.comments.push(comment);
          state.comments.sort((a, b) => a.time_sec - b.time_sec);
          renderComments(cur.id);
          renderSeekMarkers(audio.active.duration || 0);
        }
      }
    });
    socket.on('comment:deleted', ({ id, track_id }) => {
      const cur = currentTrack();
      if (cur && track_id === cur.id) {
        state.comments = state.comments.filter((c) => c.id !== id);
        renderComments(cur.id);
        renderSeekMarkers(audio.active.duration || 0);
      }
    });
  }

  function spawnReaction(emoji) {
    const layer = $('#reactionLayer');
    if (!layer || !emoji) return;

    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 140}px`);
    el.style.left = `${40 + Math.random() * 20}%`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  /* ------------------------------------------------------------------------
     BIND UI
  ------------------------------------------------------------------------ */

  function bindUI() {
    // Модалки
    $('#loginBtn').addEventListener('click', () => openAuth('login'));
    $('#logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      renderAuth();
      switchTab('all');
      toast('Ви вийшли', 'ok');
    });

    // Auth form
    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#authUsername').value.trim();
      const password = $('#authPassword').value;
      const errEl = $('#authError');
      errEl.hidden = true;

      try {
        const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const data = await api(endpoint, {
          method: 'POST',
          body: { username, password },
        });
        state.user = data.user;
        renderAuth();
        closeModal('authModal');
        toast(`Вітаємо, ${data.user.username}!`, 'ok');
        if (state.activeTab !== 'all') loadTracks(state.activeTab);
      } catch (err) {
        const map = {
          invalid_credentials: 'Невірний логін або пароль',
          username_taken: 'Таке ім\'я вже зайняте',
          invalid_username: 'Некоректне ім\'я (3-32 символи)',
          weak_password: 'Пароль має бути мінімум 8 символів',
          registration_disabled: 'Реєстрація вимкнена',
          too_many_requests: 'Занадто багато спроб. Спробуйте пізніше.',
        };
        errEl.textContent = map[err.message] || 'Помилка: ' + err.message;
        errEl.hidden = false;
      }
    });

    // Tabs
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Player controls
    $('#playBtn').addEventListener('click', () => {
      if (!currentTrack() && state.queue.length) return playTrackAt(0);
      togglePlay();
    });
    $('#nextBtn').addEventListener('click', () => next(false));
    $('#prevBtn').addEventListener('click', () => prev());

    $('#shuffleBtn').addEventListener('click', (e) => {
      state.shuffle = !state.shuffle;
      e.currentTarget.classList.toggle('active', state.shuffle);
      toast(state.shuffle ? 'Перемішано' : 'По порядку');
    });

    $('#repeatBtn').addEventListener('click', (e) => {
      state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
      e.currentTarget.classList.toggle('active', state.repeat !== 'off');
      e.currentTarget.style.opacity = state.repeat === 'one' ? '0.65' : '1';
      toast(state.repeat === 'one' ? 'Повтор треку' : state.repeat === 'all' ? 'Повтор плейлиста' : 'Повтор вимкнено');
    });

    // Like у плеєрі
    $('#likeBtn').addEventListener('click', async () => {
      const t = currentTrack();
      if (!t) return;

      if (!state.user) {
        openAuth('login');
        return;
      }

      const method = t.liked ? 'DELETE' : 'POST';
      try {
        const res = await api(`/api/tracks/${t.id}/like`, { method });
        t.liked = res.liked;
        t.likes = res.likes;
        $('#likeBtn').classList.toggle('liked', res.liked);

        const listTrack = state.tracks.find((x) => x.id === t.id);
        if (listTrack) {
          listTrack.liked = res.liked;
          listTrack.likes = res.likes;
        }
        renderTrackList();
      } catch {
        toast('Помилка', 'err');
      }
    });

    // Volume
    const volume = $('#volume');
    volume.addEventListener('input', () => {
      const v = parseFloat(volume.value);
      audio.active.volume = v;
      audio.idle.volume = v;
    });

    // Seek
    bindSeek($('#seek'));
    bindSeek($('#playerProgress'));

    // AI Prompt
    $('#promptBtn').addEventListener('click', () => {
      const t = currentTrack();
      if (!t) return toast('Оберіть трек', 'err');

      $('#promptBody').textContent = t.ai_prompt || 'Промпт не вказано.';
      $('#promptMeta').innerHTML = `
        <span>${escapeHtml(t.ai_model || 'Модель не вказана')}</span>
        ${t.genre ? `<span>${escapeHtml(t.genre)}</span>` : ''}
        ${t.tags && t.tags.length ? `<span>${escapeHtml(t.tags.join(' · '))}</span>` : ''}
      `;
      openModal('promptModal');
    });

    $('#copyPromptBtn').addEventListener('click', async () => {
      const text = $('#promptBody').textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('Скопійовано', 'ok');
      } catch {
        toast('Не вдалося скопіювати', 'err');
      }
    });

    // Comments
    $('#commentBtn').addEventListener('click', () => {
      const t = currentTrack();
      if (!t) return toast('Оберіть трек', 'err');
      openModal('commentsModal');
      $('#commentAt').textContent = fmtTime(audio.active.currentTime || 0);
    });

    $('#commentForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!state.user) {
        closeModal('commentsModal');
        openAuth('login');
        return;
      }

      const t = currentTrack();
      if (!t) return;

      const input = $('#commentInput');
      const body = input.value.trim();
      if (!body) return;

      try {
        const data = await api(`/api/tracks/${t.id}/comments`, {
          method: 'POST',
          body: { body, time_sec: audio.active.currentTime || 0 },
        });
        input.value = '';
        if (!state.comments.some((c) => c.id === data.comment.id)) {
          state.comments.push(data.comment);
          state.comments.sort((a, b) => a.time_sec - b.time_sec);
        }
        renderComments(t.id);
        renderSeekMarkers(audio.active.duration || 0);
        toast('Коментар додано', 'ok');
      } catch {
        toast('Помилка додавання коментаря', 'err');
      }
    });

    // Queue
    $('#queueBtn').addEventListener('click', () => {
      renderQueueModal();
      openModal('queueModal');
    });

    // Room
    $('#openRoomBtn').addEventListener('click', () => {
      openModal('roomModal');
      if (state.room) {
        $('#roomStart').hidden = true;
        $('#roomActive').hidden = false;
        renderRoom(state.room);
      } else {
        $('#roomStart').hidden = false;
        $('#roomActive').hidden = true;
      }
    });

    $('#createRoomBtn').addEventListener('click', () => {
      if (!socket) return toast('Socket недоступний', 'err');
      const name = $('#roomNameInput').value.trim() || 'Live Room';
      socket.emit(
        'room:create',
        { name, username: state.user ? state.user.username : 'Гість' },
        (res) => {
          if (!res.ok) return toast('Помилка створення', 'err');
          state.roomId = res.room.id;
          renderRoom(res.room);
          updateRoomUrl(res.room.id);
          toast(`Кімната ${res.room.id} створена`, 'ok');
        }
      );
    });

    $('#joinRoomBtn').addEventListener('click', () => {
      if (!socket) return toast('Socket недоступний', 'err');
      const roomId = $('#roomCodeInput').value.trim().toUpperCase();
      if (!roomId) return;
      socket.emit(
        'room:join',
        { roomId, username: state.user ? state.user.username : 'Гість' },
        (res) => {
          if (!res.ok) return toast('Кімнату не знайдено', 'err');
          state.roomId = res.room.id;
          renderRoom(res.room);
          updateRoomUrl(res.room.id);
          toast(`Приєдналися до ${res.room.id}`, 'ok');
        }
      );
    });

    $('#leaveRoomBtn').addEventListener('click', () => {
      if (socket) socket.emit('room:leave');
      state.room = null;
      state.roomId = null;
      state.isHost = false;
      $('#roomStart').hidden = false;
      $('#roomActive').hidden = true;
      updateRoomUrl(null);
      closeModal('roomModal');
      toast('Ви покинули кімнату');
    });

    $('#copyRoomLink').addEventListener('click', async () => {
      if (!state.roomId) return;
      const link = `${location.origin}/?room=${state.roomId}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Лінк скопійовано', 'ok');
      } catch {
        toast(link);
      }
    });

    $('#roomChatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#roomChatInput');
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit('room:chat', { text });
      input.value = '';
    });

    $$('#roomReactions button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!socket || !state.roomId) return;
        socket.emit('room:reaction', { emoji: btn.dataset.emoji });
        spawnReaction(btn.dataset.emoji);
      });
    });

    // Медіа-події
    for (const el of [elA, elB]) {
      el.addEventListener('timeupdate', () => {
        if (el === audio.active) updateProgress();
      });

      el.addEventListener('loadedmetadata', () => {
        if (el === audio.active) updateProgress();
      });

      el.addEventListener('progress', () => {
        if (el !== audio.active) return;
        try {
          if (el.buffered.length) {
            const end = el.buffered.end(el.buffered.length - 1);
            const dur = el.duration || 1;
            $('#seekBuffer').style.width = `${(end / dur) * 100}%`;
          }
        } catch {
          /* ignore */
        }
      });

      el.addEventListener('play', () => {
        renderPlayer();
        startProgressTimer();
      });

      el.addEventListener('pause', () => {
        renderPlayer();
        stopProgressTimer();
      });

      el.addEventListener('ended', () => {
        if (el !== audio.active) return;
        next(true);
      });

      el.addEventListener('error', () => {
        if (el !== audio.active) return;
        toast('Помилка відтворення треку', 'err');
      });
    }

    // Гарячі клавіші
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!currentTrack() && state.queue.length) playTrackAt(0);
        else togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (audio.active.duration) {
          audio.active.currentTime = Math.min(audio.active.duration, audio.active.currentTime + 5);
        }
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        audio.active.currentTime = Math.max(0, audio.active.currentTime - 5);
      } else if (e.code === 'KeyN') {
        next(false);
      } else if (e.code === 'KeyP') {
        prev();
      }
    });

    // Resize
    window.addEventListener('resize', () => {
      resizeCanvas();
    });

    // PWA install
    let deferredPrompt = null;
    const installBtn = $('#installBtn');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.hidden = false;
    });

    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    });

    window.addEventListener('appinstalled', () => {
      installBtn.hidden = true;
      toast('Застосунок встановлено', 'ok');
    });
  }

  function updateRoomUrl(roomId) {
    const url = new URL(location.href);
    if (roomId) url.searchParams.set('room', roomId);
    else url.searchParams.delete('room');
    history.replaceState({}, '', url.toString());
  }

  function startProgressTimer() {
    if (state.progressTimer) return;
    state.progressTimer = setInterval(updateProgress, 250);
  }

  function stopProgressTimer() {
    if (state.progressTimer) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
    updateProgress();
  }

  /* ------------------------------------------------------------------------
     PWA
  ------------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return;
    }

    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('[sw] реєстрація не вдалася:', err.message);
    });
  }

  /* ------------------------------------------------------------------------
     BOOT
  ------------------------------------------------------------------------ */

  async function boot() {
    resizeCanvas();
    drawVisualizer();
    bindUI();
    setupSocket();
    registerServiceWorker();

    try {
      const cfg = await api('/api/config');
      if (cfg.site_name) {
        $('#brandName').textContent = cfg.site_name;
        document.title = `${cfg.site_name} — AI Music`;
      }
      if (cfg.site_tagline) $('#heroSub').textContent = cfg.site_tagline;
    } catch {
      /* ignore */
    }

    await loadUser();
    await loadTracks('all');

    // Автоприєднання до кімнати з URL
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if (roomParam && socket) {
      const join = () => {
        socket.emit(
          'room:join',
          { roomId: roomParam.toUpperCase(), username: state.user ? state.user.username : 'Гість' },
          (res) => {
            if (res && res.ok) {
              state.roomId = res.room.id;
              renderRoom(res.room);
              openModal('roomModal');
              toast(`Приєдналися до кімнати ${res.room.id}`, 'ok');
            } else {
              toast('Кімнату не знайдено', 'err');
            }
          }
        );
      };

      if (socket.connected) join();
      else socket.once('connect', join);
    }

    // Відновлення гучності
    const savedVol = localStorage.getItem('nw_volume');
    if (savedVol !== null) {
      $('#volume').value = savedVol;
      elA.volume = parseFloat(savedVol);
      elB.volume = parseFloat(savedVol);
    }

    $('#volume').addEventListener('change', () => {
      localStorage.setItem('nw_volume', $('#volume').value);
    });

    // Перший жест — ініціалізація AudioContext
    const initOnce = () => {
      ensureAudioGraph();
      resumeAudioCtx();
      document.removeEventListener('pointerdown', initOnce);
      document.removeEventListener('keydown', initOnce);
    };
    document.addEventListener('pointerdown', initOnce);
    document.addEventListener('keydown', initOnce);

    renderPlayer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
