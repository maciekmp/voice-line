function createEngineSupervisor({ launch, onChild = () => {}, onMessage = () => {}, onError = () => {}, onStopped = () => {}, canStart = () => true, stopTimeoutMs = 3000 }) {
  let child;
  let state = 'stopped';
  let restarting;
  let stopping;

  function start() {
    if (state !== 'stopped' || !canStart()) return;
    state = 'starting';
    try { child = launch(); }
    catch (error) { state = 'stopped'; onError(error); return; }
    const instance = child;
    onChild(instance);
    instance.once('spawn', () => { if (child === instance && state === 'starting') state = 'running'; });
    instance.on('message', message => { if (child === instance && state !== 'stopping') onMessage(message); });
    instance.on('error', error => { if (child === instance && state !== 'stopping') onError(error); });
    instance.once('disconnect', () => {
      if (child !== instance || state === 'stopping') return;
      onError(new Error('Voice worker IPC disconnected'));
      instance.kill();
    });
    instance.once('close', () => {
      if (child !== instance) return;
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
      onError(error); instance.kill();
    };
    try { instance.send(message, failed); return true; }
    catch (error) { failed(error); return false; }
  }
  return { start, stop, restart, send, get state() { return state; } };
}
module.exports = { createEngineSupervisor };
