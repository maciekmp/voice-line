const { parseWorkerResult } = require('../src/worker-validation.cjs');

function createEngineSupervisor({ launch, onChild = () => {}, onMessage = () => {}, onError = () => {}, onStopped = () => {}, canStart = () => true, stopTimeoutMs = 3000, requestTimeoutMs = 5000 }) {
  let child;
  let state = 'stopped';
  let restarting;
  let stopping;
  let requestId = 0;
  const pending = new Map();
  function rejectPending() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ accepted: false, reason: 'disconnected' }); }
    pending.clear();
  }

  function start() {
    if (state !== 'stopped' || !canStart()) return;
    state = 'starting';
    try { child = launch(); }
    catch (error) { state = 'stopped'; onError(error); return; }
    const instance = child;
    onChild(instance);
    instance.once('spawn', () => { if (child === instance && state === 'starting') state = 'running'; });
    instance.on('message', message => {
      if (child !== instance || state === 'stopping') return;
      const response = parseWorkerResult(message);
      if (response) {
        const request = pending.get(response.requestId);
        if (request) { pending.delete(response.requestId); clearTimeout(request.timer); request.resolve(response.result); }
      } else onMessage(message);
    });
    instance.on('error', error => { if (child === instance && state !== 'stopping') onError(error); });
    instance.once('disconnect', () => {
      if (child !== instance || state === 'stopping') return;
      rejectPending();
      onError(new Error('Voice worker IPC disconnected'));
      instance.kill();
    });
    instance.once('close', () => {
      if (child !== instance) return;
      rejectPending();
      const expected = state === 'stopping';
      child = undefined;
      state = 'stopped';
      onChild(undefined);
      if (!expected) onStopped();
    });
  }

  function stop() {
    if (stopping) return stopping;
    if (!child) return Promise.resolve();
    const instance = child;
    state = 'stopping';
    rejectPending();
    stopping = new Promise(resolve => {
      const timer = setTimeout(() => instance.kill(), stopTimeoutMs);
      instance.once('close', () => { clearTimeout(timer); resolve(); });
      if (instance.connected) {
        try { instance.send({ command: 'shutdown' }, error => { if (error) instance.kill(); }); }
        catch { instance.kill(); }
      } else instance.kill();
    }).finally(() => { stopping = undefined; });
    return stopping;
  }

  function restart() {
    if (!restarting) restarting = stop().then(start).finally(() => { restarting = undefined; });
    return restarting;
  }
  function send(message) {
    const instance = child;
    if (!instance?.connected || state === 'stopping') return false;
    const failed = error => {
      if (!error || child !== instance || state === 'stopping') return;
      rejectPending(); onError(error); instance.kill();
    };
    try { instance.send(message, failed); return true; }
    catch (error) { failed(error); return false; }
  }
  function request(command) {
    if (!child?.connected || state === 'stopping') return Promise.resolve({ accepted: false, reason: 'disconnected' });
    const id = ++requestId;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id); resolve({ accepted: false, reason: 'timeout' });
      }, requestTimeoutMs);
      pending.set(id, { resolve, timer });
      if (!send({ type: 'request', requestId: id, command })) {
        clearTimeout(timer); pending.delete(id); resolve({ accepted: false, reason: 'disconnected' });
      }
    });
  }
  return { start, stop, restart, send, request, get state() { return state; } };
}
module.exports = { createEngineSupervisor };
