<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#07070b" />
<meta name="robots" content="noindex, nofollow" />
<title>NEONWAVE — Адмінка</title>
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/css/style.css" />
<style>
  .admin-main { max-width: 1240px; margin: 0 auto; padding: 24px 20px 80px; }
  .admin-grid { display: grid; grid-template-columns: 400px 1fr; gap: 24px; align-items: start; }
  @media (max-width: 980px) { .admin-grid { grid-template-columns: 1fr; } }

  .card {
    background: rgba(18, 18, 28, 0.75);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 22px;
    backdrop-filter: blur(14px);
  }

  .card + .card { margin-top: 20px; }
  .card h2 { font-size: 16px; font-weight: 800; margin-bottom: 16px; letter-spacing: -0.01em; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
  .stat {
    padding: 14px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid var(--border);
  }
  .stat-value { font-size: 22px; font-weight: 800; background: linear-gradient(135deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin-top: 3px; font-weight: 700; }

  .admin-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .admin-table th {
    text-align: left;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .admin-table td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
  .admin-table tr:hover td { background: rgba(255,255,255,0.03); }
  .admin-table img { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }

  .tbl-actions { display: flex; gap: 6px; justify-content: flex-end; }

  .icon-action {
    width: 30px; height: 30px;
    display: grid; place-items: center;
    border-radius: 8px;
    color: var(--text-faint);
    transition: 0.2s;
  }
  .icon-action:hover { background: rgba(255,255,255,0.08); color: var(--text); }
  .icon-action.danger:hover { background: rgba(255,77,109,0.15); color: var(--danger); }

  .upload-zone {
    border: 2px dashed rgba(255,255,255,0.14);
    border-radius: 14px;
    padding: 22px;
    text-align: center;
    transition: 0.25s var(--ease);
    cursor: pointer;
    font-size: 13px;
    color: var(--text-dim);
  }
  .upload-zone:hover, .upload-zone.dragover {
    border-color: var(--accent);
    background: rgba(0,229,255,0.06);
    color: var(--text);
  }
  .upload-zone input { display: none; }
  .file-name { margin-top: 8px; font-size: 12px; color: var(--accent); word-break: break-all; }

  .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 520px) { .row-2 { grid-template-columns: 1fr; } }

  .toast-wrap { top: auto; bottom: 24px; }

  .tabs-admin { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
</style>
</head>
<body>

<div class="ambient" aria-hidden="true"></div>
<div class="grain" aria-hidden="true"></div>

<header class="topbar">
  <a class="brand" href="/">
    <span class="brand-dot"></span>
    <span class="brand-name">NEONWAVE · ADMIN</span>
  </a>
  <div class="topbar-actions">
    <a class="btn-ghost" href="/">← На сайт</a>
    <div class="user-chip" id="userChip">
      <span class="avatar" id="userAvatar">A</span>
      <span class="user-name" id="userName">admin</span>
      <button class="icon-btn small" id="logoutBtn" title="Вийти">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 3a1 1 0 0 1 0 2H6v14h4a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5Zm7.3 5.3 3.7 3.7-3.7 3.7a1 1 0 0 1-1.4-1.4L17.6 13H10a1 1 0 1 1 0-2h7.6l-1.7-1.3a1 1 0 0 1 1.4-1.4Z"/></svg>
      </button>
    </div>
  </div>
</header>

<main class="admin-main">

  <div class="stats-grid" id="statsGrid" style="margin-bottom:24px"></div>

  <div class="tabs-admin">
    <button class="tab active" data-atab="tracks">Треки</button>
    <button class="tab" data-atab="users">Користувачі</button>
    <button class="tab" data-atab="settings">Налаштування</button>
  </div>

  <!-- ===== ТРЕКИ ===== -->
  <section id="panel-tracks">
    <div class="admin-grid">

      <div class="card">
        <h2>➕ Додати новий трек</h2>
        <form id="uploadForm" class="form">
          <div class="upload-zone" id="audioZone">
            <input type="file" id="audioInput" accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a" required />
            <div>🎵 <strong>Аудіофайл</strong><br />MP3 / WAV / FLAC / OGG / M4A</div>
            <div class="file-name" id="audioName"></div>
          </div>

          <div class="upload-zone" id="coverZone">
            <input type="file" id="coverInput" accept="image/*" />
            <div>🖼 <strong>Обкладинка</strong><br />JPG / PNG / WEBP</div>
            <div class="file-name" id="coverName"></div>
          </div>

          <label class="field">
            <span>Назва треку</span>
            <input type="text" id="upTitle" maxlength="200" placeholder="Заповниться з імені файлу" />
          </label>

          <div class="row-2">
            <label class="field">
              <span>Виконавець / автор</span>
              <input type="text" id="upArtist" maxlength="120" placeholder="AI" />
            </label>
            <label class="field">
              <span>Жанр</span>
              <input type="text" id="upGenre" maxlength="80" placeholder="Synthwave" />
            </label>
          </div>

          <label class="field">
            <span>Теги (через кому)</span>
            <input type="text" id="upTags" maxlength="240" placeholder="neon, night, retrowave" />
          </label>

          <label class="field">
            <span>ШІ-модель</span>
            <input type="text" id="upModel" maxlength="80" placeholder="Suno v4 / Udio / Stable Audio" />
          </label>

          <label class="field">
            <span>ШІ-промпт</span>
            <textarea id="upPrompt" maxlength="4000" placeholder="Повний текст підказки, за якою створено трек..."></textarea>
          </label>

          <label class="field">
            <span>Видимість</span>
            <select id="upPublic">
              <option value="true" selected>Публічний</option>
              <option value="false">Прихований</option>
            </select>
          </label>

          <div class="form-error" id="uploadError" hidden></div>

          <button type="submit" class="btn-primary" id="uploadBtn">Завантажити трек</button>
          <div id="uploadProgress" style="font-size:12px;color:var(--text-faint);text-align:center" hidden></div>
        </form>
      </div>

      <div class="card">
        <h2>🎧 Усі треки</h2>
        <div style="overflow-x:auto">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th>
                <th>Назва</th>
                <th>Жанр</th>
                <th>Стат.</th>
                <th style="text-align:right">Дії</th>
              </tr>
            </thead>
            <tbody id="tracksTbody"></tbody>
          </table>
        </div>
      </div>

    </div>
  </section>

  <!-- ===== КОРИСТУВАЧІ ===== -->
  <section id="panel-users" hidden>
    <div class="admin-grid">

      <div class="card">
        <h2>➕ Створити користувача</h2>
        <form id="userForm" class="form">
          <label class="field">
            <span>Ім'я користувача</span>
            <input type="text" id="newUsername" required minlength="3" maxlength="32" />
          </label>
          <label class="field">
            <span>Пароль</span>
            <input type="password" id="newPassword" required minlength="8" />
          </label>
          <label class="field">
            <span>Роль</span>
            <select id="newRole">
              <option value="user">Користувач</option>
              <option value="admin">Адміністратор</option>
            </select>
          </label>
          <div class="form-error" id="userError" hidden></div>
          <button type="submit" class="btn-primary">Створити</button>
        </form>
      </div>

      <div class="card">
        <h2>👥 Користувачі</h2>
        <div style="overflow-x:auto">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Ім'я</th>
                <th>Роль</th>
                <th>Треків</th>
                <th>Створено</th>
                <th style="text-align:right">Дії</th>
              </tr>
            </thead>
            <tbody id="usersTbody"></tbody>
          </table>
        </div>
      </div>

    </div>
  </section>

  <!-- ===== НАЛАШТУВАННЯ ===== -->
  <section id="panel-settings" hidden>
    <div class="admin-grid">

      <div class="card">
        <h2>⚙️ Загальні</h2>
        <form id="settingsForm" class="form">
          <label class="field">
            <span>Назва сайту</span>
            <input type="text" id="setSiteName" maxlength="60" />
          </label>
          <label class="field">
            <span>Слоган</span>
            <input type="text" id="setTagline" maxlength="200" />
          </label>
          <label class="field">
            <span>Реєстрація</span>
            <select id="setAllowReg">
              <option value="true">Відкрита</option>
              <option value="false">Тільки адмін</option>
            </select>
          </label>
          <button type="submit" class="btn-primary">Зберегти</button>
        </form>
      </div>

      <div class="card">
        <h2>🏠 Smart Home Webhook (IoT)</h2>
        <form id="webhookForm" class="form">
          <label class="field">
            <span>Увімкнено</span>
            <select id="setWebhookEnabled">
              <option value="false">Вимкнено</option>
              <option value="true">Увімкнено</option>
            </select>
          </label>
          <label class="field">
            <span>URL (Home Assistant / ESP32)</span>
            <input type="text" id="setWebhookUrl" placeholder="http://192.168.1.50:8123/api/webhook/neonwave" />
          </label>
          <p style="font-size:12.5px;color:var(--text-faint);line-height:1.6;margin-bottom:6px">
            POST-запит надсилається при <b>play</b>, <b>pause</b>, <b>track_change</b>, <b>seek</b>.
            Тіло: <code>{ event, track, position, user, timestamp }</code>
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="submit" class="btn-primary" style="flex:1;min-width:140px">Зберегти</button>
            <button type="button" class="btn-ghost" id="testWebhookBtn" style="min-width:120px">Тест</button>
          </div>
        </form>
      </div>

    </div>
  </section>

</main>

<!-- ===== МОДАЛКА РЕДАГУВАННЯ ===== -->
<div class="modal" id="editModal" hidden>
  <div class="modal-backdrop" data-close></div>
  <div class="modal-card">
    <button class="modal-close" data-close>&times;</button>
    <h2 class="modal-title">Редагувати трек</h2>
    <form id="editForm" class="form">
      <input type="hidden" id="editId" />

      <label class="field">
        <span>Назва</span>
        <input type="text" id="editTitle" required maxlength="200" />
      </label>

      <div class="row-2">
        <label class="field">
          <span>Виконавець</span>
          <input type="text" id="editArtist" maxlength="120" />
        </label>
        <label class="field">
          <span>Жанр</span>
          <input type="text" id="editGenre" maxlength="80" />
        </label>
      </div>

      <label class="field">
        <span>Теги</span>
        <input type="text" id="editTags" maxlength="240" />
      </label>

      <label class="field">
        <span>ШІ-модель</span>
        <input type="text" id="editModel" maxlength="80" />
      </label>

      <label class="field">
        <span>ШІ-промпт</span>
        <textarea id="editPrompt" maxlength="4000"></textarea>
      </label>

      <label class="field">
        <span>Нова обкладинка (необов'язково)</span>
        <input type="file" id="editCover" accept="image/*" />
      </label>

      <label class="field">
        <span>Видимість</span>
        <select id="editPublic">
          <option value="true">Публічний</option>
          <option value="false">Прихований</option>
        </select>
      </label>

      <button type="submit" class="btn-primary">Зберегти зміни</button>
    </form>
  </div>
</div>

<div class="toast-wrap" id="toastWrap"></div>

<script src="/js/admin.js"></script>
</body>
</html>
