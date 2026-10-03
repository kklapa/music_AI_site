/* ============================================================================
   NEONWAVE — Admin Panel
   ==========================================================================*/
'use strict';

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const escapeHtml = (str) =>
    String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const fmtTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const fmtBytes = (b) => {
    if (!b) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const fmtDate = (ts) => new Date(ts).toLocaleDateString('uk-UA', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });

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
    const isForm = options.body instanceof FormData;
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: isForm ? (options.headers || {}) : { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body && !isForm && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body,
    });

    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = new Error((data && data.error) || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  let me = null;

  /* ------------------------------------------------------------------------
     AUTH GUARD
  ------------------------------------------------------------------------ */

  async function checkAuth() {
    try {
      const data = await api('/api/auth/me');
      if (!data.user || data.user.role !== 'admin') {
        location.href = '/';
        return false;
      }
      me = data.user;
      $('#userName').textContent = me.username;
      const av = $('#userAvatar');
      av.textContent = me.username.charAt(0).toUpperCase();
      av.style.background = me.avatar_color || '#00e5ff';
      return true;
    } catch {
      location.href = '/';
      return false;
    }
  }

  /* ------------------------------------------------------------------------
     STATS
  ------------------------------------------------------------------------ */

  async function loadStats() {
    try {
      const s = await api('/api/admin/stats');
      $('#statsGrid').innerHTML = `
        <div class="stat"><div class="stat-value">${s.tracks}</div><div class="stat-label">Треків</div></div>
        <div class="stat"><div class="stat-value">${s.users}</div><div class="stat-label">Користувачів</div></div>
        <div class="stat"><div class="stat-value">${s.plays}</div><div class="stat-label">Прослуховувань</div></div>
        <div class="stat"><div class="stat-value">${s.comments}</div><div class="stat-label">Коментарів</div></div>
        <div class="stat"><div class="stat-value">${fmtBytes(s.storageBytes)}</div><div class="stat-label">Сховище</div></div>
      `;
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------------
     TRACKS
  ------------------------------------------------------------------------ */

  let tracks = [];

  async function loadTracks() {
    try {
      const data = await api('/api/tracks');
      tracks = data.tracks || [];
      renderTracks();
    } catch {
      toast('Не вдалося завантажити треки', 'err');
    }
  }

  function renderTracks() {
    const tbody = $('#tracksTbody');

    if (!tracks.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-faint);padding:30px">Немає треків</td></tr>';
      return;
    }

    tbody.innerHTML = tracks
      .map(
        (t) => `
        <tr data-id="${t.id}">
          <td><img src="${t.cover_url || '/icons/icon.svg'}" alt="" /></td>
          <td>
            <div style="font-weight:650">${escapeHtml(t.title)}</div>
            <div style="font-size:12px;color:var(--text-faint)">${escapeHtml(t.artist || 'AI')} · ${fmtTime(t.duration)}</div>
          </td>
          <td style="color:var(--text-dim);font-size:12.5px">${escapeHtml(t.genre || '—')}</td>
          <td style="font-size:12px;color:var(--text-faint);white-space:nowrap">
            ▶ ${t.plays} · ❤ ${t.likes || 0} · 💬 ${t.comments || 0}
          </td>
          <td>
            <div class="tbl-actions">
              <button class="icon-action" data-edit="${t.id}" title="Редагувати">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 17.2V20h2.8l9.2-9.2-2.8-2.8L4 17.2ZM19.7 7.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-1.4 1.4 2.8 2.8 1.6-1.2Z"/></svg>
              </button>
              <button class="icon-action danger" data-del="${t.id}" title="Видалити">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7Zm3-4h6l1 2H8l1-2Zm-4 2h14v2H5V5Z"/></svg>
              </button>
            </div>
          </td>
        </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-edit]').forEach((btn) =>
      btn.addEventListener('click', () => openEdit(Number(btn.dataset.edit)))
    );

    tbody.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => deleteTrack(Number(btn.dataset.del)))
    );
  }

  async function deleteTrack(id) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    if (!confirm(`Видалити «${t.title}» разом із файлами? Цю дію не можна скасувати.`)) return;

    try {
      await api(`/api/admin/tracks/${id}`, { method: 'DELETE' });
      tracks = tracks.filter((x) => x.id !== id);
      renderTracks();
      loadStats();
      toast('Трек видалено', 'ok');
    } catch {
      toast('Помилка видалення', 'err');
    }
  }

  function openEdit(id) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;

    $('#editId').value = t.id;
    $('#editTitle').value = t.title || '';
    $('#editArtist').value = t.artist || '';
    $('#editGenre').value = t.genre || '';
    $('#editTags').value = (t.tags || []).join(', ');
    $('#editModel').value = t.ai_model || '';
    $('#editPrompt').value = t.ai_prompt || '';
    $('#editPublic').value = String(t.is_public !== 0 && t.is_public !== false);
    $('#editCover').value = '';

    $('#editModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  /* ------------------------------------------------------------------------
     UPLOAD
  ------------------------------------------------------------------------ */

  function bindUploadZone(zoneId, inputId, nameId) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const nameEl = document.getElementById(nameId);

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        nameEl.textContent = input.files[0].name;
      }
    });

    input.addEventListener('change', () => {
      nameEl.textContent = input.files[0] ? input.files[0].name : '';
    });
  }

  function bindUploadForm() {
    const form = $('#uploadForm');
    const errEl = $('#uploadError');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      errEl.hidden = true;

      const audioInput = $('#audioInput');
      if (!audioInput.files.length) {
        errEl.textContent = 'Оберіть аудіофайл';
        errEl.hidden = false;
        return;
      }

      const fd = new FormData();
      fd.append('audio', audioInput.files[0]);

      const cover = $('#coverInput');
      if (cover.files.length) fd.append('cover', cover.files[0]);

      fd.append('title', $('#upTitle').value.trim());
      fd.append('artist', $('#upArtist').value.trim() || 'AI');
      fd.append('genre', $('#upGenre').value.trim());
      fd.append('tags', $('#upTags').value.trim());
      fd.append('ai_model', $('#upModel').value.trim());
      fd.append('ai_prompt', $('#upPrompt').value.trim());
      fd.append('is_public', $('#upPublic').value);

      const xhr = new XMLHttpRequest();
      const progress = $('#uploadProgress');
      const btn = $('#uploadBtn');

      progress.hidden = false;
      progress.textContent = 'Завантаження… 0%';
      btn.disabled = true;
      btn.textContent = 'Завантаження…';

      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          progress.textContent = `Завантаження… ${pct}%`;
        }
      });

      xhr.addEventListener('load', () => {
        btn.disabled = false;
        btn.textContent = 'Завантажити трек';
        progress.hidden = true;

        if (xhr.status >= 200 && xhr.status < 300) {
          form.reset();
          $('#audioName').textContent = '';
          $('#coverName').textContent = '';
          $('#upPrompt').value = '';
          toast('Трек успішно додано', 'ok');
          loadTracks();
          loadStats();
        } else {
          let msg = 'Помилка завантаження';
          try {
            const d = JSON.parse(xhr.responseText);
            msg = d.error || msg;
          } catch {
            /* ignore */
          }
          const map = {
            audio_required: 'Оберіть аудіофайл',
            file_too_large: 'Файл завеликий',
            unsupported_audio_format: 'Непідтримуваний аудіоформат',
            unsupported_image_format: 'Непідтримуваний формат зображення',
          };
          errEl.textContent = map[msg] || msg;
          errEl.hidden = false;
        }
      });

      xhr.addEventListener('error', () => {
        btn.disabled = false;
        btn.textContent = 'Завантажити трек';
        progress.hidden = true;
        errEl.textContent = 'Мережева помилка';
        errEl.hidden = false;
      });

      xhr.open('POST', '/api/admin/tracks');
      xhr.withCredentials = true;
      xhr.send(fd);
    });
  }

  function bindEditForm() {
    $('#editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = Number($('#editId').value);

      const fd = new FormData();
      fd.append('title', $('#editTitle').value.trim());
      fd.append('artist', $('#editArtist').value.trim());
      fd.append('genre', $('#editGenre').value.trim());
      fd.append('tags', $('#editTags').value.trim());
      fd.append('ai_model', $('#editModel').value.trim());
      fd.append('ai_prompt', $('#editPrompt').value);
      fd.append('is_public', $('#editPublic').value);

      const cover = $('#editCover');
      if (cover.files.length) fd.append('cover', cover.files[0]);

      try {
        await api(`/api/admin/tracks/${id}`, { method: 'PATCH', body: fd });
        $('#editModal').hidden = true;
        document.body.style.overflow = '';
        toast('Зміни збережено', 'ok');
        loadTracks();
      } catch {
        toast('Помилка збереження', 'err');
      }
    });
  }

  /* ------------------------------------------------------------------------
     USERS
  ------------------------------------------------------------------------ */

  async function loadUsers() {
    try {
      const data = await api('/api/admin/users');
      const tbody = $('#usersTbody');

      tbody.innerHTML = (data.users || [])
        .map(
          (u) => `
          <tr data-id="${u.id}">
            <td>
              <div style="display:flex;align-items:center;gap:10px">
                <span class="avatar" style="width:28px;height:28px;font-size:11px;background:${escapeHtml(u.avatar_color || '#00e5ff')}">${escapeHtml(u.username.charAt(0).toUpperCase())}</span>
                <span style="font-weight:650">${escapeHtml(u.username)}</span>
              </div>
            </td>
            <td>
              <select data-role="${u.id}" style="padding:5px 9px;border-radius:8px;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--text);font-size:12px">
                <option value="user" ${u.role === 'user' ? 'selected' : ''}>Користувач</option>
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Адмін</option>
              </select>
            </td>
            <td style="color:var(--text-dim)">${u.tracks_count}</td>
            <td style="color:var(--text-faint);font-size:12.5px">${fmtDate(u.created_at)}</td>
            <td>
              <div class="tbl-actions">
                <button class="icon-action" data-pwd="${u.id}" title="Змінити пароль">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z"/></svg>
                </button>
                <button class="icon-action danger" data-del="${u.id}" title="Видалити">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7Zm3-4h6l1 2H8l1-2Zm-4 2h14v2H5V5Z"/></svg>
                </button>
              </div>
            </td>
          </tr>`
        )
        .join('');

      tbody.querySelectorAll('[data-role]').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await api(`/api/admin/users/${sel.dataset.role}`, {
              method: 'PATCH',
              body: { role: sel.value },
            });
            toast('Роль оновлено', 'ok');
          } catch (err) {
            toast(err.message === 'last_admin' ? 'Не можна зняти останнього адміна' : 'Помилка', 'err');
            loadUsers();
          }
        });
      });

      tbody.querySelectorAll('[data-pwd]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const pwd = prompt('Новий пароль (мін. 8 символів):');
          if (!pwd) return;
          if (pwd.length < 8) return toast('Занадто короткий пароль', 'err');
          try {
            await api(`/api/admin/users/${btn.dataset.pwd}/password`, {
              method: 'POST',
              body: { password: pwd },
            });
            toast('Пароль оновлено', 'ok');
          } catch {
            toast('Помилка', 'err');
          }
        });
      });

      tbody.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Видалити цього користувача? Уся його історія та лайки буде видалено.')) return;
          try {
            await api(`/api/admin/users/${btn.dataset.del}`, { method: 'DELETE' });
            toast('Користувача видалено', 'ok');
            loadUsers();
            loadStats();
          } catch (err) {
            toast(err.message === 'cannot_delete_self' ? 'Не можна видалити себе' : 'Помилка', 'err');
          }
        });
      });
    } catch {
      toast('Не вдалося завантажити користувачів', 'err');
    }
  }

  function bindUserForm() {
    $('#userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#userError');
      errEl.hidden = true;

      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: {
            username: $('#newUsername').value.trim(),
            password: $('#newPassword').value,
            role: $('#newRole').value,
          },
        });
        e.target.reset();
        toast('Користувача створено', 'ok');
        loadUsers();
        loadStats();
      } catch (err) {
        const map = {
          username_taken: 'Таке ім\'я вже зайняте',
          invalid_username: 'Некоректне ім\'я',
          weak_password: 'Пароль занадто короткий',
        };
        errEl.textContent = map[err.message] || 'Помилка: ' + err.message;
        errEl.hidden = false;
      }
    });
  }

  /* ------------------------------------------------------------------------
     SETTINGS
  ------------------------------------------------------------------------ */

  async function loadSettings() {
    try {
      const data = await api('/api/admin/settings');
      const s = data.settings || {};
      $('#setSiteName').value = s.site_name || '';
      $('#setTagline').value = s.site_tagline || '';
      $('#setAllowReg').value = s.allow_registration === 'true' ? 'true' : 'false';
      $('#setWebhookEnabled').value = s.webhook_enabled === 'true' ? 'true' : 'false';
      $('#setWebhookUrl').value = s.webhook_url || '';
    } catch {
      toast('Не вдалося завантажити налаштування', 'err');
    }
  }

  function bindSettings() {
    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            site_name: $('#setSiteName').value.trim(),
            site_tagline: $('#setTagline').value.trim(),
            allow_registration: $('#setAllowReg').value,
          },
        });
        toast('Налаштування збережено', 'ok');
      } catch {
        toast('Помилка', 'err');
      }
    });

    $('#webhookForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            webhook_enabled: $('#setWebhookEnabled').value,
            webhook_url: $('#setWebhookUrl').value.trim(),
          },
        });
        toast('Webhook збережено', 'ok');
      } catch (err) {
        toast(err.message === 'invalid_webhook_url' ? 'Некоректний URL' : 'Помилка', 'err');
      }
    });

    $('#testWebhookBtn').addEventListener('click', async () => {
      try {
        const res = await api('/api/admin/webhook/test', { method: 'POST' });
        toast(`Webhook OK (${res.status})`, 'ok');
      } catch (err) {
        toast('Webhook не відповів: ' + err.message, 'err');
      }
    });
  }

  /* ------------------------------------------------------------------------
     TABS
  ------------------------------------------------------------------------ */

  function bindTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.atab;
        $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        ['tracks', 'users', 'settings'].forEach((p) => {
          const el = document.getElementById('panel-' + p);
          if (el) el.hidden = p !== target;
        });

        if (target === 'users') loadUsers();
        if (target === 'settings') loadSettings();
      });
    });
  }

  /* ------------------------------------------------------------------------
     BOOT
  ------------------------------------------------------------------------ */

  async function boot() {
    const ok = await checkAuth();
    if (!ok) return;

    bindTabs();
    bindUploadZone('audioZone', 'audioInput', 'audioName');
    bindUploadZone('coverZone', 'coverInput', 'coverName');
    bindUploadForm();
    bindEditForm();
    bindUserForm();
    bindSettings();

    $('#editModal').querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => {
        $('#editModal').hidden = true;
        document.body.style.overflow = '';
      })
    );

    $('#logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/';
    });

    await Promise.all([loadStats(), loadTracks()]);

    // Оновлення статистики кожні 30 секунд
    setInterval(loadStats, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
