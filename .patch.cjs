const fs = require('fs');
const F = 'src/main.js';
let s = fs.readFileSync(F, 'utf8').replace(/\r\n/g, '\n');
const rep = (from, to, what) => { if (!s.includes(from)) throw new Error('якорь: ' + what); s = s.replace(from, to); };

// Копим расход по всей задаче: один запрос пользователя — это несколько
// обращений к серверу, и показывать надо сумму, а не последний шаг
rep("  let prompt = session.chatId ? text : `${PROTOCOL}\n\nРабочая папка: ${workDir}\n\nЗадача: ${text}`;",
    "  let prompt = session.chatId ? text : `${PROTOCOL}\n\nРабочая папка: ${workDir}\n\nЗадача: ${text}`;\n"
  + "  const started = Date.now();\n  let tokens = 0;");
rep("    if (!r.ok) return { ok: false, error: r.error || `сервер ответил ${r.status}`, chatId: session.chatId };",
    "    if (!r.ok) return { ok: false, error: r.error || `сервер ответил ${r.status}`, chatId: session.chatId };\n"
  + "    tokens += r.tokens || 0;");
rep("    if (!tool) return { ok: true, text: said || r.text, chatId: session.chatId };",
    "    if (!tool) return { ok: true, text: said || r.text, chatId: session.chatId, tokens, ms: Date.now() - started };");
rep("  return { ok: true, text: 'Остановился: слишком много шагов подряд. Уточните задачу.', chatId: session.chatId };",
    "  return { ok: true, text: 'Остановился: слишком много шагов подряд. Уточните задачу.', chatId: session.chatId, tokens, ms: Date.now() - started };");

fs.writeFileSync(F, s);
console.log('главный процесс считает расход');
