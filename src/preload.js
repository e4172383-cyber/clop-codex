const { contextBridge, ipcRenderer } = require('electron');

/* Единственный мост между окном и системой. Страница не получает ни Node,
   ни файловой системы — только перечисленные ниже вызовы. Всё, что делает
   что-то на компьютере, проходит через подтверждение в main.js. */
contextBridge.exposeInMainWorld('clop', {
  state: () => ipcRenderer.invoke('state'),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  loginStart: () => ipcRenderer.invoke('login-start'),
  loginPoll: (v) => ipcRenderer.invoke('login-poll', v),
  me: () => ipcRenderer.invoke('me'),
  logout: () => ipcRenderer.invoke('logout'),
  ask: (v) => ipcRenderer.invoke('ask', v),
  newChat: () => ipcRenderer.invoke('new-chat'),

  onApprove: (fn) => ipcRenderer.on('approve', (_e, v) => fn(v)),
  answerApprove: (id, allowed) => ipcRenderer.send('approve:' + id, allowed),
  onStep: (fn) => ipcRenderer.on('step', (_e, v) => fn(v)),
  onStepDone: (fn) => ipcRenderer.on('step-done', (_e, v) => fn(v)),
});
