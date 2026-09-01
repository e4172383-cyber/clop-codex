const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/* Clop Codex — настольный помощник.

   Устройство приложения принципиально простое: думает сервер, действует
   компьютер. У приложения нет и не может быть ключей от моделей — оно
   отправляет запрос на сервер Clop ai со своим личным токеном, сервер
   считает лимиты того же Telegram-аккаунта и возвращает ответ. Поэтому из
   установщика нечего красть: он не содержит ни одного секрета, а токен
   появляется только после подтверждения в Telegram и лежит зашифрованным
   средствами Windows (DPAPI, привязка к учётной записи).

   Действия на компьютере проходят через confirm() — см. подробный разбор
   правил подтверждения там же. */

const SERVER = process.env.CLOP_SERVER || 'https://clop-ai.onrender.com';
const fileIn = (name) => path.join(app.getPath('userData'), name);

let win = null;
let session = { token: null, chatId: null };

/* ---------- хранение токена ---------- */
function saveToken(token) {
  const text = JSON.stringify({ token, server: SERVER });
  // safeStorage шифрует ключом текущей учётной записи Windows: другой
  // пользователь того же компьютера файл прочитать не сможет
  const blob = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  fs.writeFileSync(fileIn('auth.bin'), blob);
}

function loadToken() {
  try {
    const blob = fs.readFileSync(fileIn('auth.bin'));
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(blob) : blob.toString('utf8');
    const v = JSON.parse(text);
    return v && v.server === SERVER ? v.token : null;
  } catch { return null; }
}

function forgetToken() {
  try { fs.unlinkSync(fileIn('auth.bin')); } catch { /* файла могло и не быть */ }
  session.token = null;
  session.chatId = null;
}

/* ---------- настройки и разговоры ---------- */
const DEFAULTS = {
  autoRead: true,     // читать и смотреть папки внутри рабочей — без вопроса
  autoWrite: false,   // создавать и менять файлы внутри рабочей — без вопроса
  autoShell: false,   // выполнять команды внутри рабочей — без вопроса
  maxSteps: 14,       // сколько действий подряд помощник делает за один запрос
  shellTimeout: 120,  // секунд на команду, дальше обрываем
  effort: '',         // сила мышления; пусто — как выбрано в боте
  autoLaunch: false,  // запускать вместе с Windows
  enterSends: true,   // Enter отправляет, Shift+Enter переносит строку
  showUsage: true,    // подпись с расходом под ответом
  compact: false,     // плотный вид ленты
  workDir: '',
};
// Просьба остановиться приходит из окна и проверяется между шагами: обрывать
// уже запущенную команду на середине опаснее, чем дать ей закончиться
let stopRequested = false;
let settings = { ...DEFAULTS };
// «Разрешить до конца сеанса» — живёт только до закрытия приложения и на
// диск не сохраняется: это разовое послабление, а не настройка
const sessionAllow = { read: false, write: false, shell: false };

function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(fileIn(name), 'utf8')); } catch { return fallback; }
}
const saveJson = (name, v) => { try { fs.writeFileSync(fileIn(name), JSON.stringify(v)); } catch { /* диск может быть занят */ } };

/* ---------- обращения к серверу ---------- */
async function api(pathname, { method = 'POST', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;
  const r = await fetch(SERVER + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

/* ---------- рабочая папка ---------- */
let workDir = '';

function resolveIn(target) {
  const abs = path.resolve(workDir, target);
  const rel = path.relative(workDir, abs);
  // Выход за пределы рабочей папки помечаем: за него спрашиваем всегда
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { abs, outside };
}

/* ---------- правила подтверждения ----------

   Смысл настроек «не спрашивать» в том, чтобы убрать рутину, а не снять
   защиту. Поэтому послабления действуют только внутри рабочей папки и
   только на обычные действия. Три правила не отключаются никогда:

     1. Всё, что выходит за рабочую папку, спрашивается всегда — иначе
        «не спрашивать про файлы» однажды превратилось бы в переписанный
        системный каталог.
     2. Опасные команды спрашиваются всегда, даже при включённом
        автоподтверждении команд: форматирование, рекурсивное удаление,
        правка реестра, выключение, работа с учётными записями. Такие вещи
        необратимы, и минута на прочтение дешевле потерянных данных.
     3. Отказ — обычный ответ. Модель получает его текстом и продолжает
        работу, а не зависает.
*/
const DANGEROUS = [
  /\bformat\b/i, /\bdiskpart\b/i, /\bbcdedit\b/i, /\bvssadmin\b/i, /\bcipher\s+\/w/i,
  /\bdel\b[^|]*\/s/i, /\brd\b[^|]*\/s/i, /\brmdir\b[^|]*\/s/i,
  /\brm\b[^|]*-[a-z]*r[a-z]*f/i, /\brm\b[^|]*-[a-z]*f[a-z]*r/i,
  /\breg\b\s+(delete|add)/i, /\bshutdown\b/i, /\brestart-computer\b/i,
  /\bnet\s+user\b/i, /\bnet\s+localgroup\b/i, /\btaskkill\b[^|]*\/f/i,
  /\bremove-item\b[^|]*-recurse/i, /\bicacls\b/i, /\bschtasks\b/i, /\bsc\s+(delete|config)\b/i,
  /\bcurl\b[^|]*\|\s*(sh|bash|cmd)/i, /\biwr\b[^|]*\|\s*iex/i, /\binvoke-expression\b/i,
];
const isDangerous = (cmd) => DANGEROUS.some((re) => re.test(cmd));

// Показываем окно подтверждения и ждём ответа: «нет», «да», «да до конца сеанса»
function ask(kind, detail) {
  return new Promise((resolve) => {
    // Окно могли закрыть, пока мы ждём ответа: считаем это отказом, иначе вся
    // цепочка задачи повисла бы навсегда
    if (!win || win.isDestroyed()) return resolve('no');
    const id = crypto.randomBytes(6).toString('hex');
    const onClose = () => { ipcMain.removeAllListeners('approve:' + id); resolve('no'); };
    ipcMain.once('approve:' + id, (_e, answer) => {
      if (win && !win.isDestroyed()) win.off('closed', onClose);
      resolve(answer);
    });
    win.once('closed', onClose);
    win.webContents.send('approve', { id, kind, ...detail });
  });
}

async function confirm(kind, detail) {
  const auto = { read: settings.autoRead, write: settings.autoWrite, shell: settings.autoShell }[kind];
  const relaxed = auto || sessionAllow[kind];
  const mustAsk = detail.outside || (kind === 'shell' && detail.danger);
  if (relaxed && !mustAsk) return true;

  const answer = await ask(kind, detail);
  if (answer === 'session') { sessionAllow[kind] = true; return true; }
  return answer === 'yes';
}

/* ---------- инструменты, которые может попросить модель ---------- */
const MAX_OUT = 12_000;
const cut = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…обрезано, всего ${s.length} символов` : s);

async function runShell(command) {
  const danger = isDangerous(command);
  if (!(await confirm('shell', { command, dir: workDir, danger, outside: false }))) {
    return 'Пользователь отклонил выполнение команды.';
  }
  return new Promise((resolve) => {
    // Команду отдаём оболочке одним куском, но окно консоли не показываем
    const win32 = process.platform === 'win32';
    execFile(win32 ? 'cmd.exe' : '/bin/sh', win32 ? ['/d', '/s', '/c', command] : ['-c', command],
      { cwd: workDir, timeout: Math.max(5, Number(settings.shellTimeout) || 120) * 1000,
        maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && err.killed) return resolve(`Команда прервана по таймауту (${Math.max(5, Number(settings.shellTimeout) || 120)} с).\n` + cut(out));
        resolve(cut(out || (err ? String(err.message) : 'Команда выполнена, вывода нет.')));
      });
  });
}

async function readFile(target) {
  const { abs, outside } = resolveIn(target);
  if (!(await confirm('read', { path: abs, outside }))) return 'Пользователь отклонил чтение файла.';
  try {
    const st = await fsp.stat(abs);
    if (st.size > 400_000) return `Файл слишком большой (${Math.round(st.size / 1024)} КБ).`;
    return cut(await fsp.readFile(abs, 'utf8'));
  } catch (e) { return 'Не удалось прочитать: ' + e.message; }
}

async function listDir(target) {
  const { abs, outside } = resolveIn(target || '.');
  if (!(await confirm('read', { path: abs, outside }))) return 'Пользователь отклонил просмотр папки.';
  try {
    const items = await fsp.readdir(abs, { withFileTypes: true });
    return cut(items.slice(0, 400).map((d) => (d.isDirectory() ? '[папка] ' : '        ') + d.name).join('\n')
      || 'Папка пуста.');
  } catch (e) { return 'Не удалось открыть папку: ' + e.message; }
}

async function writeFile(target, content) {
  const { abs, outside } = resolveIn(target);
  const size = Buffer.byteLength(content, 'utf8');
  const exists = fs.existsSync(abs);
  if (!(await confirm('write', { path: abs, outside, size, exists, preview: content.slice(0, 1500) }))) {
    return 'Пользователь отклонил запись файла.';
  }
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return `${exists ? 'Перезаписан' : 'Создан'}: ${abs} (${size} байт)`;
  } catch (e) { return 'Не удалось записать: ' + e.message; }
}

/* ---------- разбор ответа модели ----------
   Модель просит действие маркерами. Берём только первое действие за ход:
   так пользователь видит каждый шаг и может остановиться в любой момент. */
function parseTool(text) {
  const shell = /%%%SHELL%%%\s*\n([\s\S]*?)\n?%%%END%%%/.exec(text);
  const read = /%%%READ%%%\s*\n([\s\S]*?)\n?%%%END%%%/.exec(text);
  const list = /%%%LIST%%%\s*\n([\s\S]*?)\n?%%%END%%%/.exec(text);
  const write = /%%%WRITE\s+([^\n%]+)%%%\s*\n([\s\S]*?)\n?%%%END%%%/.exec(text);
  return [
    shell && { at: shell.index, kind: 'shell', arg: shell[1].trim() },
    read && { at: read.index, kind: 'read', arg: read[1].trim() },
    list && { at: list.index, kind: 'list', arg: list[1].trim() },
    write && { at: write.index, kind: 'write', arg: write[1].trim(), body: write[2] },
  ].filter(Boolean).sort((a, b) => a.at - b.at)[0] || null;
}

function runTool(tool) {
  if (tool.kind === 'shell') return runShell(tool.arg);
  if (tool.kind === 'read') return readFile(tool.arg);
  if (tool.kind === 'list') return listDir(tool.arg);
  if (tool.kind === 'write') return writeFile(tool.arg, tool.body);
  return Promise.resolve('Неизвестное действие.');
}

const PROTOCOL = [
  'Ты работаешь на компьютере пользователя через приложение Clop Codex.',
  'Чтобы что-то сделать, выведи ровно один блок действия и остановись — приложение выполнит его и пришлёт результат.',
  '',
  'Запустить команду в рабочей папке:',
  '%%%SHELL%%%', '<команда>', '%%%END%%%',
  '',
  'Прочитать файл:',
  '%%%READ%%%', '<путь>', '%%%END%%%',
  '',
  'Посмотреть папку:',
  '%%%LIST%%%', '<путь или .>', '%%%END%%%',
  '',
  'Записать файл:',
  '%%%WRITE <путь>%%%', '<содержимое целиком>', '%%%END%%%',
  '',
  'Правила: за один ответ ровно одно действие; каждое действие может потребовать подтверждения пользователя, отказ — нормальный ответ, не повторяй его молча; когда задача выполнена, просто напиши результат обычным текстом без маркеров. Отвечай по-русски.',
].join('\n');

/* ---------- окно ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 780, minWidth: 820, minHeight: 560,
    backgroundColor: '#080b12',
    title: 'Clop Codex',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Страница не имеет доступа ни к Node, ни к файлам напрямую: всё только
      // через явные каналы в preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Внешние ссылки уводим в системный браузер, а не в окно приложения
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  session.token = loadToken();
  settings = { ...DEFAULTS, ...loadJson('settings.json', {}) };
  workDir = settings.workDir && fs.existsSync(settings.workDir) ? settings.workDir : app.getPath('documents');
  applyAutoLaunch();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------- каналы к окну ---------- */
ipcMain.handle('state', () => ({ hasToken: Boolean(session.token), server: SERVER, workDir, settings }));

ipcMain.handle('settings-set', (_e, v) => {
  settings = { ...settings, ...v };
  saveJson('settings.json', settings);
  if ('autoLaunch' in v) applyAutoLaunch();
  return settings;
});

// Автозапуск прописывается в системе, а не хранится у нас: сверяем при
// каждом изменении настройки и один раз при старте
function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.autoLaunch), args: [] });
  } catch (e) { console.error('[автозапуск]', e.message); }
}

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Рабочая папка' });
  if (!r.canceled && r.filePaths[0]) {
    workDir = r.filePaths[0];
    settings.workDir = workDir;
    saveJson('settings.json', settings);
  }
  return workDir;
});

// Разговоры лежат рядом с настройками, чтобы список чатов пережил перезапуск
ipcMain.handle('chats-load', () => loadJson('chats.json', []));
ipcMain.handle('chats-save', (_e, list) => { saveJson('chats.json', list); return true; });

// Вход: код уходит на сервер, секрет остаётся здесь. Подглядевший ссылку
// с кодом токен получить не сможет — секрета у него нет.
ipcMain.handle('login-start', async () => {
  const code = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');
  const device = `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'ПК'} · Clop Codex`;
  const r = await api('/desk/init', { body: { code, secretHash, device }, auth: false });
  if (!r.ok) return { ok: false, error: 'Сервер не принял запрос на вход.' };
  shell.openExternal(`https://t.me/${r.bot}?start=desk_${code}`);
  return { ok: true, code, secret, bot: r.bot };
});

ipcMain.handle('login-poll', async (_e, { code, secret }) => {
  const r = await api('/desk/poll', { body: { code, secret }, auth: false });
  if (r.ok && r.token) {
    session.token = r.token;
    saveToken(r.token);
    return { ok: true, user: r.user };
  }
  return { ok: false, pending: Boolean(r.pending), error: r.error };
});

ipcMain.handle('me', () => (session.token ? api('/desk/me', { method: 'GET' }) : Promise.resolve({ ok: false })));

ipcMain.handle('logout', async () => {
  if (session.token) await api('/desk/logout', { body: {} }).catch(() => {});
  forgetToken();
  return { ok: true };
});

/* Вложение выбирается системным окном и читается здесь: у окна интерфейса нет
   доступа к файлам вовсе, и заводить его ради скрепки не стоит. Наружу отдаём
   уже готовую строку base64 — ровно в том виде, в каком её ждёт сервер. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

ipcMain.handle('attach', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Прикрепить картинку или документ',
    properties: ['openFile'],
    filters: [
      { name: 'Картинки и документы', extensions: [...IMAGE_EXT, ...OFFICE_EXT] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  const name = path.basename(file);
  const ext = name.split('.').pop().toLowerCase();
  const image = IMAGE_EXT.has(ext);
  if (!image && !OFFICE_EXT.has(ext)) {
    return { error: 'Понимаю картинки (png, jpg, webp) и документы Word, Excel, PowerPoint.' };
  }
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { error: 'не удалось прочитать: ' + e.message }; }
  const limit = image ? 8 * 1024 * 1024 : 12 * 1024 * 1024;
  if (buf.length > limit) return { error: `файл больше ${limit / 1024 / 1024} МБ` };
  const mime = image ? (MIME[ext] || 'image/png') : 'application/octet-stream';
  return { name, kind: image ? 'image' : 'office', data: `data:${mime};base64,${buf.toString('base64')}` };
});

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

/* Обращение к серверу с потоком: ответ приходит событиями, и окно показывает
   текст по мере появления. Раньше приложение молча ждало готовый ответ, и
   пользователь видел «Думаю…» иногда по минуте, не понимая, идёт ли работа. */
async function askStream(body, onDelta) {
  const r = await fetch(SERVER + '/desk/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ...body, stream: true }),
  });
  // Сервер может ответить обычным JSON — например, при отказе по лимиту
  if (!String(r.headers.get('content-type') || '').includes('event-stream')) {
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // События разделены пустой строкой; последний кусок может быть неполным
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.delta) onDelta(ev.delta);
      else if (ev.done) result = ev;
    }
  }
  return result || { ok: false, error: 'поток оборвался' };
}

/* Один ход разговора: спрашиваем сервер, при необходимости выполняем
   действие на компьютере и возвращаемся к серверу с результатом. Цикл
   ограничен — иначе модель могла бы ходить по кругу без остановки. */
ipcMain.handle('ask', async (_e, { text, model, chatId, attachment }) => {
  if (!session.token) return { ok: false, error: 'нужен вход' };
  session.chatId = chatId || null;
  let prompt = session.chatId ? text : `${PROTOCOL}\n\nРабочая папка: ${workDir}\n\nЗадача: ${text}`;
  // Один запрос пользователя — это несколько обращений к серверу, поэтому
  // расход и время копим по всей задаче, а не показываем последний шаг
  const started = Date.now();
  let tokens = 0;

  const limit = Math.min(40, Math.max(2, Number(settings.maxSteps) || 14));
  stopRequested = false;
  for (let i = 0; i < limit; i++) {
    if (stopRequested) {
      stopRequested = false;
      return { ok: true, text: 'Остановлено по вашей просьбе.', chatId: session.chatId, tokens, ms: Date.now() - started };
    }
    const r = await askStream({
      text: prompt, model, chatId: session.chatId, effort: settings.effort || undefined,
        // Вложение прикладываем только к первому обращению: дальше в переписке
        // идут результаты действий, и слать картинку заново незачем
      ...(i === 0 && attachment && attachment.kind === 'image' ? { images: [attachment.data] } : {}),
      ...(i === 0 && attachment && attachment.kind === 'office'
        ? { office: { name: attachment.name, data: attachment.data } } : {}),
    }, (piece) => {
      if (win && !win.isDestroyed()) win.webContents.send('delta', piece);
    });
    if (!r.ok) return { ok: false, error: r.error || `сервер ответил ${r.status}`, chatId: session.chatId };
    session.chatId = r.chatId;
    tokens += r.tokens || 0;

    const tool = parseTool(r.text);
    const said = r.text.replace(/%%%[\s\S]*?%%%END%%%/g, '').trim();
    if (!tool) return { ok: true, text: said || r.text, chatId: session.chatId, tokens, ms: Date.now() - started };

    win.webContents.send('step', { kind: tool.kind, arg: tool.arg, say: said });
    const result = await runTool(tool);
    win.webContents.send('step-done', { kind: tool.kind, result });
    prompt = `%%%RESULT%%%\n${result}\n%%%END%%%`;
  }
  return {
    ok: true, text: `Остановился: подряд сделано ${limit} действий. Уточните задачу или поднимите предел в настройках.`,
    chatId: session.chatId, tokens, ms: Date.now() - started,
  };
});

/* ---------- проверка обновлений ----------
   Спрашиваем GitHub, какая версия последняя, и сравниваем с текущей. Проверка
   живёт в главном процессе не для удобства: у окна политика содержимого
   default-src 'none', и запрос наружу оттуда всё равно не ушёл бы.
   Ничего не скачиваем и не запускаем сами — только открываем страницу
   релиза в браузере, чтобы приложение не умело подменять себя само. */
const REPO = 'e4172383-cyber/clop-codex';

// Сравнение вида 1.10.0 против 1.9.0: по частям числами, а не строками
function newerThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

let updateCache = { at: 0, value: null };

ipcMain.handle('update-check', async () => {
  // GitHub ограничивает частоту, да и смысла чаще получаса нет
  if (Date.now() - updateCache.at < 30 * 60_000) return updateCache.value;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'user-agent': 'clop-codex', accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error('ответ ' + r.status);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    const value = latest && newerThan(latest, app.getVersion())
      ? { version: latest, url: j.html_url } : null;
    updateCache = { at: Date.now(), value };
    return value;
  } catch {
    // Нет сети или GitHub недоступен — молча ничего не показываем
    updateCache = { at: Date.now(), value: null };
    return null;
  }
});

ipcMain.handle('version', () => app.getVersion());

ipcMain.handle('stop', () => { stopRequested = true; return true; });
