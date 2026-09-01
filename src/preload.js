const { contextBridge, ipcRenderer } = require('electron');

/* Единственный мост между окном и системой. Страница не получает ни Node,
   ни файловой системы — только перечисленные ниже вызовы. Всё, что делает
   что-то на компьютере, проходит через правила подтверждения в main.js. */
contextBridge.exposeInMainWorld('clop', {
  state: () => ipcRenderer.invoke('state'),
  setSettings: (v) => ipcRenderer.invoke('settings-set', v),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  loginStart: () => ipcRenderer.invoke('login-start'),
  loginPoll: (v) => ipcRenderer.invoke('login-poll', v),
  me: () => ipcRenderer.invoke('me'),
  logout: () => ipcRenderer.invoke('logout'),

  chatsLoad: () => ipcRenderer.invoke('chats-load'),
  chatsSave: (list) => ipcRenderer.invoke('chats-save', list),
  ask: (v) => ipcRenderer.invoke('ask', v),

  onApprove: (fn) => ipcRenderer.on('approve', (_e, v) => fn(v)),
  answerApprove: (id, answer) => ipcRenderer.send('approve:' + id, answer),
  onStep: (fn) => ipcRenderer.on('step', (_e, v) => fn(v)),
  onStepDone: (fn) => ipcRenderer.on('step-done', (_e, v) => fn(v)),
});
