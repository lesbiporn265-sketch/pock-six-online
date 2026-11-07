// Pock Six online bridge for Construct 3.
// Import this file from the project's main script or copy it into Scripts/.
// The game UI can call globalThis.PockOnline.join(room, name),
// globalThis.PockOnline.start(), and globalThis.PockOnline.action(action, amount).

(() => {
  let socket = null;
  let state = null;
  let listeners = new Set();
  let url = "";
  let reconnectTimer = null;

  const emit = event => listeners.forEach(fn => { try { fn(event, state); } catch (e) { console.error(e); } });
  const send = payload => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Online connection is not open");
    socket.send(JSON.stringify(payload));
  };

  const api = {
    connect(serverUrl) {
      url = serverUrl.replace(/\/$/, "").replace(/^http/, "ws");
      if (socket) socket.close();
      socket = new WebSocket(url);
      socket.onopen = () => emit({ type: "connected" });
      socket.onmessage = event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "state") state = message;
        emit(message);
      };
      socket.onerror = error => emit({ type: "connection-error", error });
      socket.onclose = () => {
        emit({ type: "disconnected" });
        if (url && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; api.connect(url); }, 2500);
      };
    },
    join(room, name) { send({ type: "join", room: room || undefined, name }); },
    start() { send({ type: "start" }); },
    action(action, amount) { send({ type: "action", action, ...(amount == null ? {} : { amount }) }); },
    leave() { if (socket) socket.close(); },
    getState() { return state; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };

  globalThis.PockOnline = api;
})();
