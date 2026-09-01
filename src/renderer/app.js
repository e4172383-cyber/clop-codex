/* Логика окна. Ничего системного здесь нет: все действия уходят в main.js
   через мост из preload, а каждое действие на компьютере пользователь
   подтверждает вручную в окне подтверждения. */

const $ = (id) => document.getElementById(id);
const log = $('log');
let busy = false;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const scroll = () => { log.scrollTop = log.scrollHeight; };

function bubble(who, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  log.appendChild(d);
  scroll();
  return d;
}

const TITLES = { shell: 'Команда', read: 'Чтение файла', list: 'Просмотр папки', write: 'Запись файла' };

function stepCard(kind, arg, say) {
  if (say) bubble('ai', say);
  const d = document.createElement('div');
  d.className = 'step';
  d.innerHTML = `<div class="head">${esc(TITLES[kind] || kind)}</div><pre>${esc(arg)}</pre>`;
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
  $('dirBtn').textContent = st.workDir;
}

async function send() {
  if (busy) return;
  const text = $('input').value.trim();
  if (!text) return;
  busy = true;
  $('input').value = '';
  bubble('me', text);
  const wait = bubble('ai', 'Думаю…');

  const r = await window.clop.ask({ text, model: $('model').value });
  wait.remove();
  if (!r.ok) bubble('ai', '⚠️ ' + (r.error || 'не получилось'));
  else bubble('ai', r.text);
  busy = false;
  $('input').focus();
}

/* ---------- подтверждение действий ---------- */
window.clop.onApprove((v) => {
  const warn = $('askWarn');
  warn.style.display = 'none';
  if (v.kind === 'shell') {
    $('askTitle').textContent = 'Выполнить команду на компьютере?';
    $('askBody').textContent = v.command + '\n\nв папке: ' + v.dir;
  } else if (v.kind === 'write') {
    $('askTitle').textContent = 'Записать файл?';
    $('askBody').textContent = `${v.path}\n\nразмер: ${v.size} байт`;
    if (v.outside) { warn.textContent = '⚠️ Файл вне выбранной рабочей папки.'; warn.style.display = 'block'; }
  } else {
    $('askTitle').textContent = 'Прочитать вне рабочей папки?';
    $('askBody').textContent = v.path;
    warn.textContent = '⚠️ Путь вне выбранной рабочей папки.';
    warn.style.display = 'block';
  }
  $('ask').style.display = 'flex';
  const answer = (ok) => {
    $('ask').style.display = 'none';
    $('askYes').onclick = null; $('askNo').onclick = null;
    window.clop.answerApprove(v.id, ok);
  };
  $('askYes').onclick = () => answer(true);
  $('askNo').onclick = () => answer(false);
});

let currentStep = null;
window.clop.onStep((v) => { currentStep = stepCard(v.kind, v.arg, v.say); });
window.clop.onStepDone((v) => {
  if (!currentStep) return;
  const out = document.createElement('pre');
  out.className = 'out';
  out.textContent = v.result;
  currentStep.appendChild(out);
  currentStep = null;
  scroll();
});

/* ---------- кнопки ---------- */
$('loginBtn').onclick = startLogin;
$('send').onclick = send;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('dirBtn').onclick = async () => { $('dirBtn').textContent = await window.clop.pickDir(); };
$('newBtn').onclick = async () => { await window.clop.newChat(); log.innerHTML = ''; };
$('outBtn').onclick = async () => {
  await window.clop.logout();
  log.innerHTML = '';
  $('app').style.display = 'none';
  $('login').style.display = 'flex';
  $('loginBtn').disabled = false;
  $('loginStatus').textContent = '';
};

(async () => {
  const st = await window.clop.state();
  if (st.hasToken) showApp();
})();
