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

   Все действия на компьютере — запуск команд и запись файлов — выполняются
   только после явного подтверждения в окне. */

const SERVER = process.env.CLOP_SERVER || 'https://clop-ai.onrender.com';
const AUTH_FILE = () => path.join(app.getPath('userData'), 'auth.bin');

let win = null;
let session = { token: null, chatId: null };

/* ---------- хранение токена ---------- */
function saveToken(token) {
  const raw = Buffer.from(JSON.stringify({ token, server: SERVER }), 'utf8');
  // safeStorage шифрует ключом текущей учётной записи Windows: другой
  // пользователь того же компьютера файл прочитать не сможет
  const blob = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw.toString('utf8')) : raw;
  fs.writeFileSync(AUTH_FILE(), blob);
}

function loadToken() {
  try {
    const blob = fs.readFileSync(AUTH_FILE());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(blob) : blob.toString('utf8');
    const v = JSON.parse(text);
    return v && v.server === SERVER ? v.token : null;
  } catch { return null; }
}

function forgetToken() {
  try { fs.unlinkSync(AUTH_FILE()); } catch { /* файла могло и не быть */ }
  session.token = null;
  session.chatId = null;
}

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

/* ---------- рабочая папка и безопасность путей ---------- */
let workDir = app.getPath('documents');

function resolveIn(target) {
  const abs = path.resolve(workDir, target);
  const rel = path.relative(workDir, abs);
  // Выход за пределы рабочей папки помечаем: за него спросим отдельно
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { abs, outside };
}

// Спрашиваем окно и ждём ответа пользователя
function ask(kind, detail) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString('hex');
    ipcMain.once('approve:' + id, (_e, allowed) => resolve(Boolean(allowed)));
    win.webContents.send('approve', { id, kind, ...detail });
  });
}

/* ---------- инструменты, которые может попросить модель ---------- */
const MAX_OUT = 12_000;
const cut = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…обрезано, всего ${s.length} символов` : s);

async function runShell(command) {
  const okToRun = await ask('shell', { command, dir: workDir });
  if (!okToRun) return 'Пользователь отклонил выполнение команды.';
  return new Promise((resolve) => {
    // Через cmd.exe, но без оболочки в аргументах: команду отдаём одним куском
    execFile(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      { cwd: workDir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && err.killed) return resolve('Команда прервана по таймауту (120 с).\n' + cut(out));
        resolve(cut(out || (err ? String(err.message) : 'Команда выполнена, вывода нет.')));
      });
  });
}

async function readFile(target) {
  const { abs, outside } = resolveIn(target);
  if (outside && !(await ask('read', { path: abs }))) return 'Пользователь отклонил чтение файла вне рабочей папки.';
  try {
    const st = await fsp.stat(abs);
    if (st.size > 400_000) return `Файл слишком большой (${Math.round(st.size / 1024)} КБ).`;
    return cut(await fsp.readFile(abs, 'utf8'));
  } catch (e) { return 'Не удалось прочитать: ' + e.message; }
}

async function listDir(target) {
  const { abs, outside } = resolveIn(target || '.');
  if (outside && !(await ask('read', { path: abs }))) return 'Пользователь отклонил просмотр папки вне рабочей.';
  try {
    const items = await fsp.readdir(abs, { withFileTypes: true });
    return cut(items.slice(0, 400).map((d) => (d.isDirectory() ? '[папка] ' : '        ') + d.name).join('\n')
      || 'Папка пуста.');
  } catch (e) { return 'Не удалось открыть папку: ' + e.message; }
}

async function writeFile(target, content) {
  const { abs, outside } = resolveIn(target);
  const okToWrite = await ask('write', { path: abs, outside, size: Buffer.byteLength(content, 'utf8') });
  if (!okToWrite) return 'Пользователь отклонил запись файла.';
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return `Записано: ${abs} (${Buffer.byteLength(content, 'utf8')} байт)`;
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
  const first = [
    shell && { at: shell.index, kind: 'shell', arg: shell[1].trim() },
    read && { at: read.index, kind: 'read', arg: read[1].trim() },
    list && { at: list.index, kind: 'list', arg: list[1].trim() },
    write && { at: write.index, kind: 'write', arg: write[1].trim(), body: write[2] },
  ].filter(Boolean).sort((a, b) => a.at - b.at)[0];
  return first || null;
}

async function runTool(tool) {
  if (tool.kind === 'shell') return runShell(tool.arg);
  if (tool.kind === 'read') return readFile(tool.arg);
  if (tool.kind === 'list') return listDir(tool.arg);
  if (tool.kind === 'write') return writeFile(tool.arg, tool.body);
  return 'Неизвестное действие.';
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
  'Правила: за один ответ ровно одно действие; каждое действие пользователь подтверждает вручную, отказ — нормальный ответ, не повторяй его молча; когда задача выполнена, просто напиши результат обычным текстом без маркеров. Отвечай по-русски.',
].join('\n');

/* ---------- окно ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 760, minWidth: 760, minHeight: 520,
    backgroundColor: '#0b0f18',
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
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------- каналы к окну ---------- */
ipcMain.handle('state', () => ({ hasToken: Boolean(session.token), server: SERVER, workDir }));

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Рабочая папка' });
  if (!r.canceled && r.filePaths[0]) workDir = r.filePaths[0];
  return workDir;
});

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

ipcMain.handle('me', async () => (session.token ? api('/desk/me', { method: 'GET' }) : { ok: false }));

ipcMain.handle('logout', async () => {
  if (session.token) await api('/desk/logout', { body: {} }).catch(() => {});
  forgetToken();
  return { ok: true };
});

/* Один ход разговора: спрашиваем сервер, при необходимости выполняем
   действие на компьютере и возвращаемся к серверу с результатом. Цикл
   ограничен — иначе модель могла бы ходить по кругу без остановки. */
ipcMain.handle('ask', async (_e, { text, model }) => {
  if (!session.token) return { ok: false, error: 'нужен вход' };
  const steps = [];
  let prompt = session.chatId ? text : `${PROTOCOL}\n\nРабочая папка: ${workDir}\n\nЗадача: ${text}`;

  for (let i = 0; i < 12; i++) {
    const r = await api('/desk/chat', { body: { text: prompt, model, chatId: session.chatId } });
    if (!r.ok) return { ok: false, error: r.error || `сервер ответил ${r.status}`, steps };
    session.chatId = r.chatId;

    const tool = parseTool(r.text);
    const said = r.text.replace(/%%%[\s\S]*?%%%END%%%/g, '').trim();
    if (!tool) return { ok: true, text: said || r.text, steps };

    steps.push({ kind: tool.kind, arg: tool.arg, say: said });
    win.webContents.send('step', { kind: tool.kind, arg: tool.arg, say: said });
    const result = await runTool(tool);
    win.webContents.send('step-done', { kind: tool.kind, result });
    prompt = `%%%RESULT%%%\n${result}\n%%%END%%%`;
  }
  return { ok: true, text: 'Остановился: слишком много шагов подряд. Уточните задачу.', steps };
});

ipcMain.handle('new-chat', () => { session.chatId = null; return { ok: true }; });
