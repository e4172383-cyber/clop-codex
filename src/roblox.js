'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/* Связь с Roblox Studio.

   Направление выбрано единственно возможное: плагин Студии сам приходит к
   приложению. Наружу Студия ничего не слушает, зато из плагина разрешены
   запросы по HTTP — так же работает и Rojo. Приложение поднимает крохотный
   сервер только на 127.0.0.1, поэтому из сети до него не достучаться.

   Плагин исполняет не произвольный Luau, а разбор понятного набора действий:
   создать объект, изменить свойства, положить скрипт, показать дерево. Так
   надёжнее (в плагинах нет loadstring) и понятнее человеку, который читает
   подтверждение перед выполнением. */

const PLUGIN_NAME = 'ClopCodex.server.lua';
const COMMAND_TIMEOUT_MS = 60_000;

let server = null;
let порт = 0;
let секрет = '';
let последнийВизит = 0;
let сведения = null;          // что за плейс открыт: имя, id, кто вошёл
const очередь = [];            // команды, ещё не отданные плагину
const ждущие = [];             // висящие запросы плагина за командой
const выполняемые = new Map(); // id -> ожидание ответа

const новыйId = () => crypto.randomBytes(6).toString('hex');

/* Плагин живёт, пока стучится: он опрашивает раз в пару секунд и держит
   ожидание до 20, поэтому полминуты тишины — уже потеря связи. */
const СВЯЗЬ_МС = 35_000;
const наСвязи = () => Date.now() - последнийВизит < СВЯЗЬ_МС;

function проверитьСекрет(req, url) {
  const дан = String(req.headers['x-clop-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(дан, 'utf8');
  const b = Buffer.from(секрет, 'utf8');
  if (!секрет || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

const телоЗапроса = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 2_000_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const ответ = (res, код, obj) => {
  const тело = JSON.stringify(obj);
  res.writeHead(код, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(тело);
};

function выдатьКоманду() {
  while (очередь.length) {
    const c = очередь.shift();
    if (выполняемые.has(c.id)) return c.команда;
  }
  return null;
}

function запросить(res) {
  const сразу = выдатьКоманду();
  if (сразу) return ответ(res, 200, { ok: true, command: сразу });

  let закрыт = false;
  const разбудить = () => {
    if (закрыт) return;
    закрыт = true;
    clearTimeout(таймер);
    ответ(res, 200, { ok: true, command: выдатьКоманду() });
  };
  const таймер = setTimeout(() => {
    if (закрыт) return;
    закрыт = true;
    const i = ждущие.indexOf(разбудить);
    if (i >= 0) ждущие.splice(i, 1);
    ответ(res, 200, { ok: true, command: null });
  }, 20_000);
  ждущие.push(разбудить);
}

function обработчик(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!проверитьСекрет(req, url)) return ответ(res, 401, { ok: false, error: 'нет доступа' });
  последнийВизит = Date.now();

  if (url.pathname === '/hello') {
    return телоЗапроса(req).then((b) => {
      сведения = {
        place: String(b.place || '').slice(0, 120),
        placeId: b.placeId || 0,
        user: String(b.user || '').slice(0, 80),
        studio: String(b.studio || '').slice(0, 40),
      };
      ответ(res, 200, { ok: true, app: 'clop-codex' });
    });
  }

  if (url.pathname === '/poll') return запросить(res);

  if (url.pathname === '/result') {
    return телоЗапроса(req).then((b) => {
      const ждёт = выполняемые.get(String(b.id));
      if (ждёт) {
        выполняемые.delete(String(b.id));
        clearTimeout(ждёт.таймер);
        ждёт.resolve({ ok: b.ok !== false, output: String(b.output || '') });
      }
      ответ(res, 200, { ok: true });
    });
  }

  return ответ(res, 404, { ok: false, error: 'нет такого маршрута' });
}

/* ---------- управление ---------- */

function старт(желаемыйПорт = 34873) {
  if (server) return { ok: true, port: порт, token: секрет };
  секрет = секрет || crypto.randomBytes(18).toString('hex');
  return new Promise((resolve) => {
    server = http.createServer(обработчик);
    server.on('error', (e) => {
      server = null;
      resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `порт ${желаемыйПорт} занят` : e.message });
    });
    // Слушаем только петлю: из сети до приложения достучаться нельзя
    server.listen(желаемыйПорт, '127.0.0.1', () => {
      порт = server.address().port;
      resolve({ ok: true, port: порт, token: секрет });
    });
  });
}

function стоп() {
  if (!server) return;
  try { server.close(); } catch { /* уже закрыт */ }
  server = null;
  порт = 0;
  последнийВизит = 0;
  сведения = null;
  for (const [, ж] of выполняемые) { clearTimeout(ж.таймер); ж.resolve({ ok: false, output: 'связь со Студией выключена' }); }
  выполняемые.clear();
  очередь.length = 0;
}

const состояние = () => ({
  running: Boolean(server),
  port: порт,
  connected: наСвязи(),
  place: сведения,
  lastSeen: последнийВизит || null,
  pluginPath: путьПлагина(),
  pluginInstalled: fs.existsSync(путьПлагина()),
});

/** Отправляет команду в Студию и ждёт ответа плагина. */
function отправить(команда) {
  if (!server) return Promise.resolve({ ok: false, output: 'связь со Студией выключена в настройках' });
  if (!наСвязи()) return Promise.resolve({ ok: false, output: 'плагин не на связи: откройте Roblox Studio и нажмите кнопку Clop Codex на панели «Плагины»' });

  return new Promise((resolve) => {
    const id = новыйId();
    const таймер = setTimeout(() => {
      выполняемые.delete(id);
      resolve({ ok: false, output: 'Студия не ответила за минуту' });
    }, COMMAND_TIMEOUT_MS);
    выполняемые.set(id, { resolve, таймер });
    очередь.push({ id, команда: { id, ...команда } });
    const w = ждущие.shift();
    if (w) w();
  });
}

/* ---------- плагин ---------- */

function папкаПлагинов() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
  }
  // macOS: Studio хранит плагины в поддержке приложений
  return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
}
const путьПлагина = () => path.join(папкаПлагинов(), PLUGIN_NAME);

/* Исходник плагина лежит рядом заготовкой: порт и секрет подставляются при
   установке, чтобы человеку не пришлось ничего копировать руками. */
function исходникПлагина() {
  const шаблон = fs.readFileSync(path.join(__dirname, 'studio-plugin.lua'), 'utf8');
  return шаблон
    .split('__CLOP_PORT__').join(String(порт || 34873))
    .split('__CLOP_TOKEN__').join(секрет || '');
}

function установитьПлагин() {
  try {
    if (!секрет) секрет = crypto.randomBytes(18).toString('hex');
    fs.mkdirSync(папкаПлагинов(), { recursive: true });
    fs.writeFileSync(путьПлагина(), исходникПлагина(), 'utf8');
    return { ok: true, path: путьПлагина() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function удалитьПлагин() {
  try { fs.unlinkSync(путьПлагина()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { старт, стоп, состояние, отправить, установитьПлагин, удалитьПлагин, путьПлагина };
