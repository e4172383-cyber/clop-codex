/* Переносит заставку с сайта-чата в приложение.

   Заставка на сайте — три куска одного целого: стили, разметка и движок на
   WebGL. Вместо копирования вручную вытаскиваем их прямо из chat.html, чтобы
   приложение и сайт не разъезжались. Движок кладём отдельным файлом: у окна
   строгая политика содержимого (script-src 'self'), встроенные скрипты она
   не пропускает. */
const fs = require('node:fs');
const path = require('node:path');

const SITE = process.env.CLOP_SITE
  || path.join(__dirname, '..', '..', 'clop-ai', 'src', 'public', 'chat.html');
const R = path.join(__dirname, '..', 'src', 'renderer');

const page = fs.readFileSync(SITE, 'utf8').replace(/\r\n/g, '\n');
const between = (from, to, what) => {
  const i = page.indexOf(from), j = page.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error('не найдено на сайте: ' + what);
  return page.slice(i, j).trimEnd();
};

const css = between('  /* --- Заставка загрузки ---', '  /* --- Общая стеклянная поверхность ---', 'стили');
const html = between('<!-- Заставка:', '<div id="login">', 'разметка');
let js = between('/* Заставка: осенний закат', 'async function boot()', 'движок');

// Приложение запускается часто, поэтому ждать столько же, сколько сайт при
// холодном старте, незачем: сокращаем ожидание и показ спонсоров, сцены и
// их порядок остаются теми же
js = js.replace('DOTS_UNTIL = 7200', 'DOTS_UNTIL = 3800')
       .replace('SPON_DUR = 3300', 'SPON_DUR = 2600');

fs.writeFileSync(path.join(R, 'loader.js'), js + '\n');
fs.writeFileSync(path.join(R, 'loader.css'), css + '\n');
fs.writeFileSync(path.join(R, 'loader.html'), html + '\n');
console.log(`перенесено: движок ${js.length}, стили ${css.length}, разметка ${html.length} символов`);
