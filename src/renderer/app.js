/* Логика окна. Ничего системного здесь нет: все действия уходят в main.js
   через мост из preload, а правила подтверждения живут там же. Здесь —
   только список разговоров, переписка и окна настроек и подтверждения. */

const $ = (id) => document.getElementById(id);
const log = $('log');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Прокручиваем вниз, только если пользователь и так внизу: иначе он читает
// вывод выше, а лента дёргает его к последнему сообщению
let stickToBottom = true;
const nearBottom = () => log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
const scroll = () => { if (stickToBottom) log.scrollTop = log.scrollHeight; };
log.addEventListener('scroll', () => { stickToBottom = nearBottom(); });

let chats = [];        // [{ id, title, chatId, messages:[{who,text}] }]
let current = null;    // текущий разговор
let settings = {};
let attachment = null;   // выбранная картинка или документ
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
  liveStep = null;          // карточка прошлого разговора больше не наша
  stickToBottom = true;
  log.innerHTML = '';
  if (!c.messages.length) showEmpty();
  for (const m of c.messages) {
    if (m.who === 'step') stepCard(m.kind, m.arg, m.say, m.result);
    else {
      bubble(m.who, m.text);
      if (m.who === 'ai' && (m.tokens || m.ms)) metaLine(m.tokens, m.ms);
    }
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
/* Состояние аккаунта — модели, тариф, силы мышления, акции — приходит с
   сервера и перечитывается раз в минуту. Поэтому появление новой модели или
   акции доезжает до окна само: переустанавливать приложение не нужно. */
function applyMe(me) {
  $('who').textContent = me.name;
  $('plan').textContent = '· ' + me.plan;

  const effortNow = $('selEffort').value;
  $('selEffort').innerHTML = '<option value="">Как в боте</option>'
    + (me.efforts || []).map((x) => `<option value="${esc(x.key)}">${esc(x.title)}</option>`).join('');
  $('selEffort').value = settings.effort || effortNow || '';

  // Выбор пользователя не сбрасываем, пока модель ему доступна: иначе список
  // сам собой перескакивал бы на другую модель посреди работы
  const chosen = $('model').value;
  const models = me.models || [];
  const keep = models.some((m) => m.key === chosen) ? chosen : me.model;
  $('model').innerHTML = models
    .map((m) => `<option value="${esc(m.key)}"${m.key === keep ? ' selected' : ''}>${esc(m.title)}</option>`)
    .join('');

  showPromo(me.promo);
}

function showPromo(p) {
  const el = $('promo');
  if (!p || !p.until || Date.now() >= p.until) { el.style.display = 'none'; return; }
  $('promoText').textContent = '🎁 ' + p.title;
  const left = Math.max(0, Math.round((p.until - Date.now()) / 60000));
  $('promoLeft').textContent = left >= 1 ? `ещё ${left} мин` : 'заканчивается';
  el.style.display = 'flex';
}

async function refreshMe() {
  const me = await window.clop.me().catch(() => null);
  if (me && me.ok) applyMe(me);
}

async function showApp() {
  const me = await window.clop.me();
  if (!me || !me.ok) { $('login').style.display = 'flex'; $('app').style.display = 'none'; return; }
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
  applyMe(me);

  const st = await window.clop.state();
  settings = st.settings;
  $('dirBtn').textContent = st.workDir;
  syncSettings();

  chats = (await window.clop.chatsLoad()) || [];
  if (!chats.length) newChat(); else openChat(chats[0]);
}

// «Думаю…» живёт до первого события: дальше о ходе работы рассказывают
// карточки шагов, и висящий пузырь только мешает
let thinking = null;
function dropThinking() {
  if (thinking) { thinking.remove(); thinking = null; }
}

const nf = new Intl.NumberFormat('ru-RU');
function humanTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
}

function metaLine(tokens, ms) {
  if (settings.showUsage === false) return;
  if (!tokens && !ms) return;
  const d = document.createElement('div');
  d.className = 'meta';
  d.innerHTML = `${nf.format(tokens || 0)} токенов <i></i> ${humanTime(ms || 0)}`;
  log.appendChild(d);
  scroll();
}

/* Разговор, которому принадлежит идущая работа. Пока помощник думает,
   пользователь может открыть другой чат или удалить этот — тогда ответ и шаги
   обязаны лечь в свой разговор, а в ленту попасть только если он всё ещё
   открыт. Без этой привязки ответ уезжал в чужую переписку. */
let sent = null;
const stillOpen = () => sent && current && sent.id === current.id;

function setBusy(on) {
  busy = on;
  $('send').style.display = on ? 'none' : '';
  const stop = $('stopBtn');
  stop.style.display = on ? 'flex' : 'none';
  stop.disabled = false;
  // Подпись меняется на «Останавливаю…», её нужно вернуть к следующему разу
  if (on) stop.lastChild.textContent = ' Стоп';
}

async function send() {
  try { await sendInner(); } catch (e) {
    setBusy(false);
    dropThinking();
    bubble('ai', '⚠️ Не удалось отправить: ' + String((e && e.message) || e));
  }
}

async function sendInner() {
  if (busy || !current) return;
  let text = $('input').value.trim();
  if (!text && !attachment) return;
  // С одним вложением и без слов вопрос очевиден — подставляем его сами
  if (!text) {
    text = attachment.kind === 'image'
      ? 'Опиши, что на изображении, и ответь по его содержимому.'
      : 'Прокомментируй документ: о чём он и что важное внутри.';
  }
  setBusy(true);
  $('input').value = '';
  sent = current;
  stickToBottom = true;

  // Вложение снимаем сразу: следующее сообщение уже без него
  const att = attachment;
  clearAttachment();
  const shown = att ? `${att.kind === 'image' ? '🖼' : '📄'} ${att.name}\n${text}` : text;
  bubble('me', shown);
  sent.messages.push({ who: 'me', text: shown });
  // Название разговора — по первой фразе, как на сайте
  if (sent.messages.length === 1) {
    sent.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
    renderList();
  }
  liveText = '';
  thinking = bubble('ai', 'Думаю…');
  thinking.classList.add('think');

  let r;
  try {
    r = await window.clop.ask({ text, model: $('model').value, chatId: sent.chatId, attachment: att });
  } catch (e) {
    // Без этого перехвата busy оставался бы взведённым навсегда, и окно
    // переставало принимать сообщения до перезапуска
    r = { ok: false, error: String((e && e.message) || e) };
  }
  dropThinking();
  if (r.chatId) sent.chatId = r.chatId;
  const answer = r.ok ? r.text : '⚠️ ' + (r.error || 'не получилось');
  sent.messages.push({ who: 'ai', text: answer, tokens: r.tokens, ms: r.ms });
  if (stillOpen()) {
    bubble('ai', answer);
    metaLine(r.tokens, r.ms);
  }
  saveChats();
  sent = null;
  setBusy(false);
  $('input').focus();
}

/* ---------- шаги работы ---------- */
let liveStep = null;
// Текст ответа идёт кусками: показываем его прямо в пузыре ожидания, чтобы
// было видно, что работа идёт, а не висит
let liveText = '';
window.clop.onDelta((piece) => {
  if (!thinking) return;
  liveText += piece;
  thinking.classList.remove('think');
  thinking.textContent = liveText.slice(-4000);
  scroll();
});

window.clop.onStep((v) => {
  liveText = '';
  dropThinking();
  liveStep = stillOpen() ? stepCard(v.kind, v.arg, v.say) : null;
  if (sent) sent.messages.push({ who: 'step', kind: v.kind, arg: v.arg, say: v.say });
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
  if (sent) {
    const last = sent.messages[sent.messages.length - 1];
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
const SWITCHES = {
  swRead: 'autoRead', swWrite: 'autoWrite', swShell: 'autoShell',
  swLaunch: 'autoLaunch', swEnter: 'enterSends', swUsage: 'showUsage', swCompact: 'compact',
};

function syncSettings() {
  for (const [id, key] of Object.entries(SWITCHES)) $(id).classList.toggle('on', Boolean(settings[key]));
  $('inSteps').value = settings.maxSteps ?? 14;
  $('inTimeout').value = settings.shellTimeout ?? 120;
  $('selEffort').value = settings.effort || '';
  document.body.classList.toggle('compact', Boolean(settings.compact));
}

async function apply(patch, el) {
  settings = await window.clop.setSettings(patch);
  syncSettings();
  if (el) el.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
}

for (const [id, key] of Object.entries(SWITCHES)) {
  $(id).onclick = (e) => apply({ [key]: !settings[key] }, e.currentTarget);
}
// Числа зажимаем сразу в поле: попросить 500 шагов подряд можно, а вот
// получить их — нет, и лучше честно показать, что вышло
$('inSteps').onchange = (e) => apply({ maxSteps: Math.min(40, Math.max(2, Number(e.target.value) || 14)) });
$('inTimeout').onchange = (e) => apply({ shellTimeout: Math.min(600, Math.max(5, Number(e.target.value) || 120)) });
$('selEffort').onchange = (e) => apply({ effort: e.target.value });

$('clearBtn').onclick = async () => {
  if (busy) return;
  chats = [];
  await window.clop.chatsSave(chats);
  newChat();
  $('clearBtn').textContent = 'Удалено';
  setTimeout(() => { $('clearBtn').textContent = 'Удалить все разговоры'; }, 1600);
};

/* ---------- вложения ---------- */
function clearAttachment() {
  attachment = null;
  $('chip').style.display = 'none';
}

$('clipBtn').onclick = async () => {
  const a = await window.clop.attach();
  if (!a) return;
  if (a.error) { bubble('ai', '⚠️ ' + a.error); return; }
  attachment = a;
  $('chipName').textContent = (a.kind === 'image' ? '🖼 ' : '📄 ') + a.name;
  $('chip').style.display = 'flex';
};
$('chipRm').onclick = clearAttachment;

/* ---------- обновления ----------
   Кнопка появляется, только когда вышла версия новее установленной. Нажатие
   открывает страницу релиза в браузере: приложение ничего не скачивает и не
   запускает само — обновляется пользователь, осознанно. */
async function checkUpdate() {
  const btn = $('updBtn');
  const up = await window.clop.checkUpdate().catch(() => null);
  if (!up) { btn.style.display = 'none'; return; }
  btn.querySelector('.v').textContent = up.version;
  btn.style.display = 'flex';
  btn.onclick = () => window.clop.openExternal(up.url);
}

/* ---------- кнопки ---------- */
$('loginBtn').onclick = startLogin;
$('send').onclick = send;
$('input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const send1 = settings.enterSends === false ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
  if (send1) { e.preventDefault(); send(); }
});
$('stopBtn').onclick = (e) => {
  window.clop.stop();
  e.currentTarget.disabled = true;
  e.currentTarget.lastChild.textContent = ' Останавливаю…';
};
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

/* Запуск. Пока играет заставка, окно успевает проверить токен и подтянуть
   аккаунт, поэтому за анимацией не прячется пустое ожидание: убираем её,
   когда готовы обе стороны — и данные, и сама сцена. */
(async () => {
  const st = await window.clop.state();
  settings = st.settings || {};
  if (st.hasToken) await showApp();

  // Заставка идёт своим чередом, а проверка обновления — фоном: если GitHub
  // недоступен, запуск от этого не задержится
  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
  // Модели, тариф и акции меняются на стороне сервера — перечитываем их
  setInterval(refreshMe, 60_000);

  if (typeof loaderReady === 'undefined') return;
  loaderReady.data();
  await loaderReady.done;
  hideLoader();
})();
