// Pocket Mail: mobile-first mail client. No build step, no framework.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const TOKEN_KEY = 'pocketmail.token';

const ICONS = {
  inbox: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10Z',
  sent: 'M2 21 23 12 2 3v7l15 2-15 2v7Z',
  drafts: 'M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2Zm17.7-10.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8Z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z',
  junk: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z',
  archive: 'M20.5 5.2 19.1 3.5A1.5 1.5 0 0 0 18 3H6a1.5 1.5 0 0 0-1.2.5L3.5 5.2A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.5-1.3ZM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5Z',
  all: 'M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z',
  flagged: 'M5 21V4h9l.4 2H20v10h-7l-.4-2H7v7H5Z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z',
  clip: 'M16.5 6v11.5a4 4 0 1 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 1 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 1 0-8 0v12.5a5.5 5.5 0 1 0 11 0V6h-1.5Z',
  mail: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 4-8 5-8-5V6l8 5 8-5v2Z',
};
const ROLE_NAMES = {
  inbox: 'Вхідні', sent: 'Надіслані', drafts: 'Чернетки', trash: 'Кошик',
  junk: 'Спам', archive: 'Архів', all: 'Уся пошта', flagged: 'З позначкою',
};
const ROLE_ORDER = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

const state = {
  token: null,
  account: null,
  folders: [],
  folder: 'INBOX',
  filter: 'all',
  search: '',
  page: 1,
  total: 0,
  messages: [],
  loading: false,
  current: null, // open message
  compose: null, // { mode: 'new'|'reply'|'replyAll'|'forward', source?, files: [] }
};

// ---------- helpers ----------

function svg(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function displayName(a) {
  if (!a) return '(невідомо)';
  return a.name || a.address;
}

function fmtAddr(a) {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function initials(a) {
  const src = (a && (a.name || a.address)) || '?';
  const parts = src.replace(/[<>"@.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

const AVATAR_COLORS = ['#8764b8', '#0078d4', '#038387', '#ca5010', '#498205', '#c239b3', '#986f0b', '#e3008c', '#4f6bed', '#107c10'];
function avatarColor(a) {
  const key = (a && a.address) || '';
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatar(a, cls = '') {
  return `<span class="avatar ${cls}" style="background:${avatarColor(a)}">${esc(initials(a))}</span>`;
}

function fmtDate(iso, long = false) {
  const d = new Date(iso);
  const now = new Date();
  if (long) return d.toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const days = (now - d) / 86400000;
  if (days < 6) return d.toLocaleDateString('uk-UA', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('uk-UA');
}

function fmtSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function folderLabel(f) {
  return (f.role && ROLE_NAMES[f.role]) || f.name;
}

function folderByRole(role) {
  return state.folders.find((f) => f.role === role);
}

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 5000 : 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error('Невірний ключ доступу');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- navigation (Android back button closes overlays) ----------

const overlayStack = [];
function openOverlay(id) {
  const el = document.getElementById(id);
  el.hidden = false;
  el.scrollTop = 0;
  overlayStack.push(id);
  history.pushState({ overlay: id }, '');
}
function closeTopOverlay() {
  const id = overlayStack.pop();
  if (id) document.getElementById(id).hidden = true;
}
function back() {
  if (overlayStack.length) history.back();
}
window.addEventListener('popstate', () => {
  if (!$('#sheet').hidden) { $('#sheet').hidden = true; return; }
  closeTopOverlay();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', back));

// ---------- auth ----------

function showLogin(error) {
  $('#main').hidden = true;
  $('#login').hidden = false;
  $('#login-error').hidden = !error;
  $('#login-error').textContent = error || '';
}

function logout() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  state.token = null;
  closeDrawer();
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#login-token').value.trim();
  try {
    const res = await fetch('/api/account', { headers: { authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error(res.status === 401 ? 'Невірний ключ доступу' : `Помилка сервера (${res.status})`);
    try { localStorage.setItem(TOKEN_KEY, state.token); } catch {}
    $('#login-token').value = '';
    await start();
  } catch (err) {
    showLogin(err.message);
  }
});

// ---------- drawer & folders ----------

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}
$('#open-drawer').onclick = openDrawer;
$('#scrim').onclick = closeDrawer;

async function loadFolders() {
  const { folders } = await api('/api/folders');
  folders.sort((a, b) => {
    const ra = a.role ? ROLE_ORDER.indexOf(a.role) : 99;
    const rb = b.role ? ROLE_ORDER.indexOf(b.role) : 99;
    return ra - rb || a.path.localeCompare(b.path);
  });
  state.folders = folders;
  renderFolders();
}

function renderFolders() {
  const list = $('#folder-list');
  list.innerHTML = state.folders
    .map((f) => {
      const showCount = f.unread && !['sent', 'trash', 'junk', 'drafts'].includes(f.role);
      return `<li><button class="drawer-item${f.path === state.folder ? ' active' : ''}" data-path="${esc(f.path)}">
        ${svg(ICONS[f.role] || ICONS.folder)}<span>${esc(folderLabel(f))}</span>
        ${showCount ? `<span class="count">${f.unread}</span>` : ''}</button></li>`;
    })
    .join('');
  list.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      selectFolder(b.dataset.path);
      closeDrawer();
    }),
  );
  const cur = state.folders.find((f) => f.path === state.folder);
  $('#folder-title').textContent = state.search ? `Пошук: ${state.search}` : cur ? folderLabel(cur) : state.folder;
}

function selectFolder(path) {
  state.folder = path;
  state.search = '';
  $('#search-input').value = '';
  $('#searchbar').hidden = true;
  renderFolders();
  reload();
}

// ---------- list ----------

document.querySelectorAll('#filters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.filter = chip.dataset.filter;
    reload();
  }),
);

$('#open-search').onclick = () => {
  $('#searchbar').hidden = false;
  $('#search-input').focus();
};
$('#close-search').onclick = () => {
  $('#searchbar').hidden = true;
  if (state.search) {
    state.search = '';
    $('#search-input').value = '';
    renderFolders();
    reload();
  }
};
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  state.search = e.target.value.trim();
  e.target.blur();
  renderFolders();
  reload();
});

async function reload() {
  state.page = 1;
  state.messages = [];
  $('#msg-list').innerHTML = '';
  await loadPage();
}

async function loadPage() {
  if (state.loading) return;
  state.loading = true;
  const footer = $('#list-footer');
  footer.innerHTML = '<div class="spinner"></div>';
  try {
    const params = new URLSearchParams({ folder: state.folder, page: String(state.page), pageSize: '30' });
    if (state.search) params.set('q', state.search);
    if (state.filter === 'unread') params.set('unread', '1');
    if (state.filter === 'flagged') params.set('flagged', '1');
    const r = await api(`/api/messages?${params}`);
    state.total = r.total;
    state.messages.push(...r.messages);
    renderList();
  } catch (err) {
    footer.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    state.loading = false;
  }
}

function hasMore() {
  return state.messages.length < state.total;
}

function msgItem(m) {
  const who = state.folder === (folderByRole('sent') || {}).path || state.folder === (folderByRole('drafts') || {}).path
    ? (m.to[0] && `Кому: ${displayName(m.to[0])}`) || '(без адресата)'
    : displayName(m.from);
  const whoAddr = state.folder === (folderByRole('sent') || {}).path ? m.to[0] : m.from;
  return `<li class="msg${m.seen ? '' : ' unread'}" data-uid="${m.uid}">
    <div class="msg-bg"><span>${svg(ICONS.archive)}</span><span>${svg(ICONS.trash)}</span></div>
    <div class="msg-inner">
      ${avatar(whoAddr)}
      <div class="msg-main">
        <div class="msg-row"><span class="msg-from">${esc(who)}</span><span class="msg-date">${esc(fmtDate(m.date))}</span></div>
        <div class="msg-row"><span class="msg-subject" style="flex:1">${esc(m.subject)}</span>
          <span class="msg-icons">${m.hasAttachments ? svg(ICONS.clip) : ''}${m.flagged ? `<span class="flag">${svg(ICONS.flagged)}</span>` : ''}</span></div>
        <div class="msg-preview">${esc(m.preview)}</div>
      </div>
    </div>
  </li>`;
}

function renderList() {
  const list = $('#msg-list');
  if (!state.messages.length) {
    list.innerHTML = `<li class="empty">${svg(ICONS.mail)}<p>${state.search ? 'Нічого не знайдено' : 'Тут поки що порожньо'}</p></li>`;
  } else {
    list.innerHTML = state.messages.map(msgItem).join('');
    list.querySelectorAll('.msg').forEach(bindSwipe);
  }
  $('#list-footer').textContent = hasMore() ? '' : state.messages.length ? `${state.total} листів` : '';
}

// Infinite scroll
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && hasMore() && !state.loading && state.token && state.messages.length) {
    state.page += 1;
    loadPage();
  }
}).observe($('#list-footer'));

function messageByUid(uid) {
  return state.messages.find((m) => m.uid === uid);
}

function dropFromList(uid) {
  state.messages = state.messages.filter((m) => m.uid !== uid);
  state.total = Math.max(0, state.total - 1);
  renderList();
}

// Swipe right = archive, swipe left = delete (like Outlook mobile)
function bindSwipe(li) {
  const inner = li.querySelector('.msg-inner');
  const bg = li.querySelector('.msg-bg');
  const uid = Number(li.dataset.uid);
  let startX = 0, startY = 0, dx = 0, tracking = false, swiping = false;

  inner.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; dx = 0; tracking = true; swiping = false;
  });
  inner.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!swiping && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5) {
      swiping = true;
      inner.setPointerCapture(e.pointerId);
      inner.style.transition = 'none';
    }
    if (swiping) {
      dx = mx;
      inner.style.transform = `translateX(${dx}px)`;
      bg.style.background = dx > 0 ? 'var(--success)' : 'var(--danger)';
      bg.style.justifyContent = dx > 0 ? 'flex-start' : 'flex-end';
    }
  });
  const end = async () => {
    if (!tracking) return;
    tracking = false;
    inner.style.transition = '';
    if (!swiping) return;
    const threshold = li.offsetWidth * 0.3;
    if (Math.abs(dx) < threshold) {
      inner.style.transform = '';
      return;
    }
    inner.style.transform = `translateX(${dx > 0 ? '' : '-'}110%)`;
    try {
      if (dx > 0) await archiveMessage(state.folder, uid);
      else await deleteMessage(state.folder, uid);
    } catch (err) {
      inner.style.transform = '';
      toast(err.message);
    }
  };
  inner.addEventListener('pointerup', end);
  inner.addEventListener('pointercancel', end);
  inner.addEventListener('click', (e) => {
    if (swiping) { e.preventDefault(); return; }
    openMessage(uid);
  });
}

// Pull to refresh
(function pullToRefresh() {
  const ptr = $('#ptr');
  let startY = null, dist = 0;
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0 && !$('#main').hidden && !overlayStack.length) startY = e.touches[0].clientY;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dist = Math.max(0, Math.min(90, e.touches[0].clientY - startY));
    ptr.classList.add('pulling');
    ptr.style.height = `${dist * 0.6}px`;
    ptr.firstElementChild.textContent = dist > 70 ? 'Відпустіть, щоб оновити' : 'Потягніть, щоб оновити';
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    ptr.classList.remove('pulling');
    if (dist > 70) {
      ptr.firstElementChild.textContent = 'Оновлення…';
      await refreshAll();
    }
    ptr.style.height = '0';
    dist = 0;
  });
})();

async function refreshAll() {
  await Promise.all([reload(), loadFolders().catch(() => {})]);
}

// ---------- actions ----------

async function archiveMessage(folder, uid) {
  const target = folderByRole('archive');
  if (!target) throw new Error('Папку «Архів» не знайдено');
  if (target.path === folder) throw new Error('Лист уже в архіві');
  await api('/api/move', { method: 'POST', body: { folder, uid, target: target.path } });
  dropFromList(uid);
  toast('Архівовано');
  loadFolders().catch(() => {});
}

async function deleteMessage(folder, uid) {
  await api('/api/delete', { method: 'POST', body: { folder, uid } });
  dropFromList(uid);
  toast(folder === (folderByRole('trash') || {}).path ? 'Видалено назавжди' : 'Переміщено в кошик');
  loadFolders().catch(() => {});
}

async function setFlags(folder, uid, flags) {
  await api('/api/message', { method: 'PATCH', body: { folder, uid, ...flags } });
  const m = messageByUid(uid);
  if (m) Object.assign(m, flags);
  if (state.current && state.current.uid === uid) Object.assign(state.current, flags);
  renderList();
}

// ---------- reader ----------

async function openMessage(uid) {
  const body = $('#reader-body');
  body.innerHTML = '<div class="spinner"></div>';
  openOverlay('reader');
  try {
    const { message } = await api(`/api/message?${new URLSearchParams({ folder: state.folder, uid: String(uid) })}`);
    state.current = message;
    renderReader(message, false);
    if (!message.seen) {
      setFlags(state.folder, uid, { seen: true }).then(() => loadFolders()).catch(() => {});
    }
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function attachmentUrl(m, a, inline) {
  const p = new URLSearchParams({ folder: m.folder, uid: String(m.uid), index: String(a.index), token: state.token });
  if (inline) p.set('inline', '1');
  return `/api/attachment?${p}`;
}

function renderReader(m, showImages) {
  const body = $('#reader-body');
  const recipients = [
    m.to.length ? `Кому: ${m.to.map(displayName).join(', ')}` : '',
    m.cc.length ? `Копія: ${m.cc.map(displayName).join(', ')}` : '',
  ].filter(Boolean);
  const hasRemote = m.html && /<img[^>]+src=["']?https?:/i.test(m.html);
  body.innerHTML = `
    <h2 class="reader-subject">${esc(m.subject)}</h2>
    <div class="reader-meta">
      ${avatar(m.from)}
      <div class="who">
        <div class="strong">${esc(displayName(m.from))}</div>
        <div class="muted small">${esc(m.from ? m.from.address : '')}</div>
        ${recipients.map((r) => `<div class="muted small">${esc(r)}</div>`).join('')}
      </div>
      <div class="muted small">${esc(fmtDate(m.date, true))}</div>
    </div>
    ${m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => `
      <a class="attachment" href="${esc(attachmentUrl(m, a, true))}" target="_blank" rel="noopener">
        ${svg(ICONS.clip)}<span>${esc(a.filename)}</span><span class="muted small">${fmtSize(a.size)}</span></a>`).join('')}</div>` : ''}
    ${hasRemote && !showImages ? `<div class="notice"><span>Зовнішні зображення заблоковано</span><button class="link-btn" id="show-images">Показати</button></div>` : ''}
    <div id="reader-content"></div>`;
  $('#r-flag').style.color = m.flagged ? 'var(--flag)' : '';
  const content = $('#reader-content');
  if (m.html) {
    const frame = document.createElement('iframe');
    frame.className = 'reader-frame';
    // No allow-scripts: email HTML never runs code. allow-same-origin only lets us measure its height.
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const imgSrc = showImages ? 'data: https: http:' : 'data:';
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:">
      <meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">
      <style>body{margin:0;padding:8px;font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f24;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>
      </head><body>${m.html}</body></html>`;
    const fit = () => {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.body) frame.style.height = `${doc.documentElement.scrollHeight + 8}px`;
      } catch {}
    };
    frame.addEventListener('load', () => {
      fit();
      frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
    });
    content.appendChild(frame);
  } else {
    content.innerHTML = `<div class="reader-text">${linkify(esc(m.text))}</div>`;
  }
  const btn = $('#show-images');
  if (btn) btn.onclick = () => renderReader(m, true);
}

function linkify(escaped) {
  return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

$('#r-flag').onclick = () => {
  const m = state.current;
  if (m) setFlags(m.folder, m.uid, { flagged: !m.flagged }).then(() => {
    $('#r-flag').style.color = m.flagged ? 'var(--flag)' : '';
    toast(m.flagged ? 'Позначено' : 'Позначку знято');
  }).catch((e) => toast(e.message));
};
$('#r-archive').onclick = async () => {
  const m = state.current;
  if (!m) return;
  try { await archiveMessage(m.folder, m.uid); back(); } catch (e) { toast(e.message); }
};
$('#r-delete').onclick = async () => {
  const m = state.current;
  if (!m) return;
  try { await deleteMessage(m.folder, m.uid); back(); } catch (e) { toast(e.message); }
};
$('#r-more').onclick = () => {
  const m = state.current;
  if (!m) return;
  const targets = state.folders.filter((f) => f.path !== m.folder);
  openSheet(`
    <button class="drawer-item" data-act="unread">${svg(ICONS.mail)}Позначити непрочитаним</button>
    <div class="sheet-title">Перемістити до</div>
    ${targets.map((f) => `<button class="drawer-item" data-move="${esc(f.path)}">${svg(ICONS[f.role] || ICONS.folder)}${esc(folderLabel(f))}</button>`).join('')}`,
  async (btn) => {
    try {
      if (btn.dataset.act === 'unread') {
        await setFlags(m.folder, m.uid, { seen: false });
        loadFolders().catch(() => {});
        back();
      } else if (btn.dataset.move) {
        await api('/api/move', { method: 'POST', body: { folder: m.folder, uid: m.uid, target: btn.dataset.move } });
        dropFromList(m.uid);
        loadFolders().catch(() => {});
        toast('Переміщено');
        back();
      }
    } catch (e) {
      toast(e.message);
    }
  });
};

function openSheet(html, onPick) {
  const sheet = $('#sheet');
  $('#sheet-inner').innerHTML = html;
  sheet.hidden = false;
  history.pushState({ sheet: true }, '');
  sheet.onclick = (e) => {
    const btn = e.target.closest('button');
    if (e.target === sheet || btn) {
      history.back(); // closes the sheet via popstate
      if (btn) setTimeout(() => onPick(btn), 0);
    }
  };
}

// ---------- compose ----------

$('#compose-btn').onclick = () => openCompose({ mode: 'new' });
$('#r-reply').onclick = () => state.current && openCompose({ mode: 'reply', source: state.current });
$('#r-reply-all').onclick = () => state.current && openCompose({ mode: 'replyAll', source: state.current });
$('#r-forward').onclick = () => state.current && openCompose({ mode: 'forward', source: state.current });
$('#c-show-cc').onclick = () => {
  $('#c-cc-row').hidden = false;
  $('#c-bcc-row').hidden = false;
  $('#c-show-cc').hidden = true;
  $('#c-cc').focus();
};

function prefix(p, subject) {
  return new RegExp(`^\\s*${p}:`, 'i').test(subject) ? subject : `${p}: ${subject}`;
}

function openCompose(c) {
  state.compose = { ...c, files: [] };
  const src = c.source;
  const isReply = c.mode === 'reply' || c.mode === 'replyAll';
  $('#compose-title').textContent = { new: 'Новий лист', reply: 'Відповідь', replyAll: 'Відповідь усім', forward: 'Переслати' }[c.mode];
  const me = (state.account && state.account.address || '').toLowerCase();
  let to = '', cc = '';
  if (isReply) {
    const primary = src.replyTo.length ? src.replyTo : src.from ? [src.from] : [];
    to = primary.map(fmtAddr).join(', ');
    if (c.mode === 'replyAll') {
      cc = [...src.to, ...src.cc].filter((a) => a.address.toLowerCase() !== me && !primary.some((p) => p.address === a.address)).map(fmtAddr).join(', ');
    }
  }
  $('#c-to').value = to;
  $('#c-cc').value = cc;
  $('#c-bcc').value = '';
  // For replies the server derives recipients from the original, so they are shown read-only.
  for (const id of ['#c-to', '#c-cc']) $(id).readOnly = isReply;
  $('#c-cc-row').hidden = !cc;
  $('#c-bcc-row').hidden = true;
  $('#c-show-cc').hidden = isReply || !!cc;
  $('#c-subject').value = src ? prefix(isReply ? 'Re' : 'Fwd', src.subject) : '';
  $('#c-subject').readOnly = isReply || c.mode === 'forward';
  $('#c-body').value = '';
  const quote = $('#c-quote');
  quote.hidden = !src;
  if (src) {
    quote.textContent = `${fmtDate(src.date, true)}, ${displayName(src.from)}:\n${src.text.slice(0, 2000)}`;
    if (c.mode === 'forward' && src.attachments.length) quote.textContent = `Вкладення буде переслано: ${src.attachments.map((a) => a.filename).join(', ')}\n\n${quote.textContent}`;
  }
  renderComposeFiles();
  openOverlay('compose');
  setTimeout(() => (isReply ? $('#c-body') : $('#c-to')).focus(), 50);
}

function renderComposeFiles() {
  const box = $('#c-attachments');
  box.innerHTML = state.compose.files
    .map((f, i) => `<span class="attachment">${svg(ICONS.clip)}<span>${esc(f.filename)}</span><span class="muted small">${fmtSize(f.size)}</span><button type="button" data-rm="${i}" aria-label="Прибрати">×</button></span>`)
    .join('');
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    state.compose.files.splice(Number(b.dataset.rm), 1);
    renderComposeFiles();
  }));
}

$('#c-files').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const total = state.compose.files.reduce((s, f) => s + f.size, 0) + file.size;
    if (total > 25 * 1024 * 1024) {
      toast('Максимум 25 МБ вкладень');
      break;
    }
    const content = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    state.compose.files.push({ filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, content });
  }
  e.target.value = '';
  renderComposeFiles();
});

function splitAddrs(s) {
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

$('#c-send').onclick = async () => {
  const c = state.compose;
  if (!c) return;
  const text = $('#c-body').value;
  const attachments = c.files.map(({ filename, contentType, content }) => ({ filename, contentType, content }));
  const btn = $('#c-send');
  btn.disabled = true;
  try {
    if (c.mode === 'reply' || c.mode === 'replyAll') {
      await api('/api/reply', { method: 'POST', body: { folder: c.source.folder, uid: c.source.uid, text, replyAll: c.mode === 'replyAll', attachments } });
    } else if (c.mode === 'forward') {
      const to = splitAddrs($('#c-to').value);
      if (!to.length) throw new Error('Вкажіть отримувача');
      await api('/api/forward', { method: 'POST', body: { folder: c.source.folder, uid: c.source.uid, to, text } });
    } else {
      const to = splitAddrs($('#c-to').value);
      if (!to.length) throw new Error('Вкажіть отримувача');
      if (!$('#c-subject').value.trim() && !confirm('Надіслати лист без теми?')) return;
      await api('/api/send', {
        method: 'POST',
        body: { to, cc: splitAddrs($('#c-cc').value), bcc: splitAddrs($('#c-bcc').value), subject: $('#c-subject').value, text, attachments },
      });
    }
    state.compose = null;
    back();
    toast('Надіслано');
    loadFolders().catch(() => {});
  } catch (err) {
    toast(`Не надіслано: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

// ---------- Claude connection page ----------

function copyBox(textValue) {
  return `<div class="copy-box"><pre>${esc(textValue)}</pre><button type="button" data-copy="${esc(textValue)}">Копіювати</button></div>`;
}

$('#open-claude').onclick = () => {
  closeDrawer();
  const origin = location.origin;
  const token = state.token;
  const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  const httpsOk = location.protocol === 'https:' && !isLocal;
  $('#claude-body').innerHTML = `
    <p>Claude отримує доступ до цієї поштової скриньки через протокол MCP: може шукати й читати листи, відповідати, пересилати, надсилати нові, позначати й переносити.</p>
    <p class="warn">Посилання нижче містять ваш секретний ключ. Не публікуйте їх. Щоб заборонити Claude надсилати й видаляти листи, запустіть сервер з <code>MCP_READ_ONLY=1</code>.</p>

    <h2>1. Claude.ai та мобільний застосунок Claude</h2>
    ${httpsOk ? '' : '<p class="warn">Для claude.ai сервер має бути доступний з інтернету через HTTPS (наприклад, Cloudflare Tunnel). Див. README.</p>'}
    <ol>
      <li>Відкрийте claude.ai → <b>Settings → Connectors → Add custom connector</b>.</li>
      <li>Назва: <b>Pocket Mail</b>. URL:</li>
    </ol>
    ${copyBox(`${origin}/mcp/${token}`)}
    <p class="muted small">Конектор, доданий на claude.ai, автоматично працює і в мобільному застосунку Claude.</p>

    <h2>2. Claude Code</h2>
    ${copyBox(`claude mcp add --transport http pocket-mail ${origin}/mcp --header "Authorization: Bearer ${token}"`)}

    <h2>3. Claude Desktop (локально, без сервера)</h2>
    <p>Додайте в <code>claude_desktop_config.json</code> (шлях до папки <code>mail-app</code> замініть на свій):</p>
    ${copyBox(JSON.stringify({ mcpServers: { 'pocket-mail': { command: 'bun', args: ['/ШЛЯХ/ДО/mail-app/server/mcp-stdio.ts'] } } }, null, 2))}

    <h2>Що можна попросити в Claude</h2>
    <ul>
      <li>«Підсумуй непрочитані листи за сьогодні»</li>
      <li>«Знайди рахунок від Anna і скажи суму»</li>
      <li>«Відповідай Олені, що зустріч у четвер підтверджую»</li>
      <li>«Перенеси всі розсилки GitHub в архів»</li>
    </ul>`;
  $('#claude-body').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Скопійовано');
    } catch {
      toast('Не вдалося скопіювати');
    }
  }));
  openOverlay('claude');
};

$('#logout').onclick = logout;

// ---------- boot ----------

async function start() {
  $('#login').hidden = true;
  $('#main').hidden = false;
  const { account } = await api('/api/account');
  state.account = account;
  for (const el of [$('#me-avatar'), $('#drawer-avatar')]) {
    el.textContent = initials(account);
    el.style.background = avatarColor(account);
  }
  $('#drawer-name').textContent = account.name || account.address;
  $('#drawer-email').textContent = account.address;
  await loadFolders().catch((e) => toast(e.message));
  const inbox = folderByRole('inbox');
  state.folder = inbox ? inbox.path : 'INBOX';
  renderFolders();
  await reload();
}

// Refresh when the app comes back to the foreground, and every 2 minutes while visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && !overlayStack.length) refreshAll();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && state.token && !overlayStack.length && window.scrollY < 50) refreshAll();
}, 120000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(function boot() {
  try { state.token = localStorage.getItem(TOKEN_KEY); } catch {}
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromUrl) {
    state.token = fromUrl;
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch {}
    history.replaceState(null, '', location.pathname);
  }
  if (state.token) start().catch((e) => showLogin(e.message));
  else showLogin();
})();
