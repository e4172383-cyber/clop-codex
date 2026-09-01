/* Логика окна. Ничего системного здесь нет: все действия уходят в main.js
   через мост из preload, а правила подтверждения живут там же. Здесь —
   только список разговоров, переписка и окна настроек и подтверждения. */

const $ = (id) => document.getElementById(id);
const log = $('log');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const scroll = () => { log.scrollTop = log.scrollHeight; };

let chats = [];        // [{ id, title, chatId, messages:[{who,text}] }]
let current = null;    // текущий разговор
let settings = {};
let busy = false;

/* ---------- список разговоров ---------- */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function saveChats() { window.clop.chatsSave(chats); }

function renderList() {
  $('chatList').innerHTML = chats.map((c) => `
    <div class="chat-item ${current && c.id === current.id ? 'on' : ''}" data-id="${c.id}">
      <span>${esc(c.title || 'Без названия')}</span><span class="x" data-del="${c.id}">✕</span>
    </div>`).join('') || '<div class="muted" style="padding:10px 12px">Пока пусто</div>';
}

function openChat(c) {
  current = c;
  log.innerHTML = '';
  if (!c.messages.length) showEmpty();
  for (const m of c.messages) {
    if (m.who === 'step') stepCard(m.kind, m.arg, m.say, m.result);
    else bubble(m.who, m.text);
  }
  renderList();
  scroll();
}

function newChat() {
  const c = { id: newId(), title: 'Новый разговор', chatId: null, messages: [] };
  chats.unshift(c);
  saveChats();
  openChat(c);
}

function showEmpty() {
  log.innerHTML = '<div class="empty">Опишите задачу обычными словами.<br><br>'
    + 'Помощник посмотрит папку, прочитает нужные файлы, запустит команды и соберёт результат — '
    + 'каждый шаг вы видите, а важные подтверждаете.</div>';
}

/* ---------- сообщения ---------- */
function bubble(who, text) {
  if (log.querySelector('.empty')) log.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  log.appendChild(d);
  scroll();
  return d;
}

const TITLES = { shell: 'Команда', read: 'Чтение', list: 'Просмотр папки', write: 'Запись файла' };

function stepCard(kind, arg, say, result) {
  if (log.querySelector('.empty')) log.innerHTML = '';
  if (say) bubble('ai', say);
  const d = document.createElement('div');
  d.className = 'step';
  d.innerHTML = `<div class="head">${esc(TITLES[kind] || kind)}</div><pre>${esc(arg)}</pre>`;
  if (result !== undefined) {
    const out = document.createElement('pre');
    out.className = 'out';
    out.textContent = result;
    d.appendChild(out);
  }
  log.appendChild(d);
  scroll();
  return d;
}

/* ---------- вход ---------- */
async function startLogin() {
  const status = $('loginStatus');
  $('loginBtn').disabled = true;
  status.textContent = 'Открываю Telegram…';
  const r = await window.clop.loginStart();
  if (!r.ok) { status.textContent = r.error || 'Не вышло начать вход.'; $('loginBtn').disabled = false; return; }
  status.textContent = 'Подтвердите вход в Telegram — окно ждёт…';

  // Токен выдаётся только в обмен на секрет, который остался на этом ПК
  for (let i = 0; i < 100; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const p = await window.clop.loginPoll({ code: r.code, secret: r.secret });
    if (p.ok) { status.textContent = 'Готово!'; return showApp(); }
    if (!p.pending) {
      status.textContent = p.error || 'Код устарел — попробуйте ещё раз.';
      $('loginBtn').disabled = false;
      return;
    }
  }
  status.textContent = 'Время ожидания вышло — нажмите вход ещё раз.';
  $('loginBtn').disabled = false;
}

/* ---------- рабочий экран ---------- */
async function showApp() {
  const me = await window.clop.me();
  if (!me || !me.ok) { $('login').style.display = 'flex'; $('app').style.display = 'none'; return; }
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  $('who').textContent = me.name;
  $('plan').textContent = '· ' + me.plan;
  $('model').innerHTML = (me.models || [])
    .map((m) => `<option value="${esc(m.key)}"${m.key === me.model ? ' selected' : ''}>${esc(m.title)}</option>`)
    .join('');

  const st = await window.clop.state();
  settings = st.settings;
  $('dirBtn').textContent = st.workDir;
  syncSwitches();

  chats = (await window.clop.chatsLoad()) || [];
  if (!chats.length) newChat(); else openChat(chats[0]);
}

async function send() {
  if (busy || !current) return;
  const text = $('input').value.trim();
  if (!text) return;
  busy = true;
  $('input').value = '';
  bubble('me', text);
  current.messages.push({ who: 'me', text });
  // Название разговора — по первой фразе, как на сайте
  if (current.messages.length === 1) {
    current.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
    renderList();
  }
  const wait = bubble('ai', 'Думаю…');

  const r = await window.clop.ask({ text, model: $('model').value, chatId: current.chatId });
  wait.remove();
  if (r.chatId) current.chatId = r.chatId;
  const answer = r.ok ? r.text : '⚠️ ' + (r.error || 'не получилось');
  bubble('ai', answer);
  current.messages.push({ who: 'ai', text: answer });
  saveChats();
  busy = false;
  $('input').focus();
}

/* ---------- шаги работы ---------- */
let liveStep = null;
window.clop.onStep((v) => {
  liveStep = stepCard(v.kind, v.arg, v.say);
  if (current) current.messages.push({ who: 'step', kind: v.kind, arg: v.arg, say: v.say });
});
window.clop.onStepDone((v) => {
  if (liveStep) {
    const out = document.createElement('pre');
    out.className = 'out';
    out.textContent = v.result;
    liveStep.appendChild(out);
    liveStep = null;
    scroll();
  }
  if (current) {
    const last = current.messages[current.messages.length - 1];
    if (last && last.who === 'step') last.result = v.result;
    saveChats();
  }
});

/* ---------- подтверждение действия ---------- */
window.clop.onApprove((v) => {
  const flag = $('askFlag'), pathEl = $('askPath');
  flag.style.display = 'none';
  pathEl.style.display = 'none';

  if (v.kind === 'shell') {
    $('askTitle').textContent = 'Выполнить команду?';
    $('askBody').textContent = v.command;
    pathEl.textContent = 'в папке: ' + v.dir;
    pathEl.style.display = 'block';
    if (v.danger) {
      flag.className = 'flag bad';
      flag.textContent = '⛔️ Команда выглядит опасной: она может необратимо удалить данные или изменить систему. Такие команды спрашиваются всегда, даже если автоподтверждение включено. Прочитайте её целиком.';
      flag.style.display = 'block';
    }
  } else if (v.kind === 'write') {
    $('askTitle').textContent = v.exists ? 'Перезаписать файл?' : 'Создать файл?';
    pathEl.textContent = v.path;
    pathEl.style.display = 'block';
    $('askBody').textContent = (v.preview || '') + (v.size > 1500 ? `\n\n…всего ${v.size} байт` : '');
    if (v.outside) {
      flag.className = 'flag warn';
      flag.textContent = '⚠️ Файл вне выбранной рабочей папки — такое спрашивается всегда.';
      flag.style.display = 'block';
    } else if (v.exists) {
      flag.className = 'flag warn';
      flag.textContent = '⚠️ Файл уже существует, его содержимое будет заменено.';
      flag.style.display = 'block';
    }
  } else {
    $('askTitle').textContent = 'Прочитать вне рабочей папки?';
    $('askBody').textContent = v.path;
    flag.className = 'flag warn';
    flag.textContent = '⚠️ Путь вне выбранной рабочей папки — такое спрашивается всегда.';
    flag.style.display = 'block';
  }

  // «До конца сеанса» не предлагаем там, где послабление не действует:
  // вне рабочей папки и на опасных командах всё равно спросим снова
  const canSession = !v.outside && !v.danger;
  $('askSession').style.display = canSession ? '' : 'none';

  $('ask').style.display = 'flex';
  const answer = (a) => {
    $('ask').style.display = 'none';
    window.clop.answerApprove(v.id, a);
  };
  $('askYes').onclick = () => answer('yes');
  $('askNo').onclick = () => answer('no');
  $('askSession').onclick = () => answer('session');
});

/* ---------- настройки ---------- */
function syncSwitches() {
  $('swRead').classList.toggle('on', Boolean(settings.autoRead));
  $('swWrite').classList.toggle('on', Boolean(settings.autoWrite));
  $('swShell').classList.toggle('on', Boolean(settings.autoShell));
}

async function toggle(key, el) {
  settings = await window.clop.setSettings({ [key]: !settings[key] });
  syncSwitches();
  el.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
}

$('swRead').onclick = (e) => toggle('autoRead', e.currentTarget);
$('swWrite').onclick = (e) => toggle('autoWrite', e.currentTarget);
$('swShell').onclick = (e) => toggle('autoShell', e.currentTarget);

/* ---------- кнопки ---------- */
$('loginBtn').onclick = startLogin;
$('send').onclick = send;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('newBtn').onclick = newChat;
$('sbBtn').onclick = () => document.body.classList.toggle('collapsed');
$('setBtn').onclick = () => { $('setOverlay').style.display = 'flex'; };

const pickDir = async () => {
  const dir = await window.clop.pickDir();
  $('dirBtn').textContent = dir;
};
$('dirBtn').onclick = pickDir;
$('dirBtn2').onclick = pickDir;

$('outBtn').onclick = async () => {
  await window.clop.logout();
  log.innerHTML = '';
  chats = [];
  current = null;
  $('app').style.display = 'none';
  $('login').style.display = 'flex';
  $('loginBtn').disabled = false;
  $('loginStatus').textContent = '';
};

document.addEventListener('click', (e) => {
  const close = e.target.getAttribute && e.target.getAttribute('data-close');
  if (close) $(close).style.display = 'none';

  const del = e.target.getAttribute && e.target.getAttribute('data-del');
  if (del) {
    e.stopPropagation();
    chats = chats.filter((c) => c.id !== del);
    saveChats();
    if (current && current.id === del) { if (chats.length) openChat(chats[0]); else newChat(); }
    else renderList();
    return;
  }
  const item = e.target.closest && e.target.closest('.chat-item');
  if (item && item.dataset.id) {
    const c = chats.find((x) => x.id === item.dataset.id);
    if (c) openChat(c);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const o of document.querySelectorAll('.overlay')) {
    if (o.id !== 'ask') o.style.display = 'none';   // окно подтверждения закрывается только кнопками
  }
});

(async () => {
  const st = await window.clop.state();
  settings = st.settings || {};
  if (st.hasToken) showApp();
})();
