function normalizeBaseUrl(url) {
  return (url || '').replace(/\/+$/, '');
}

function getWsBaseUrl() {
  return normalizeBaseUrl(process.env.REACT_APP_WS_BASE_URL || 'ws://localhost:8080');
}

export class WebSocketClient {
  constructor() {
    this.ws = null;
    this.eventHandlers = {};
    this.pendingMessages = [];
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(getWsBaseUrl());

    this.ws.onopen = () => {
      this.emit('connect');
      for (const msg of this.pendingMessages) {
        this.ws.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.type) {
          this.emit(data.type, data);
        }
      } catch {
        // Ignore malformed payloads.
      }
    };

    this.ws.onclose = () => {
      this.emit('disconnect');
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(type, handler) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
  }

  emit(type, event) {
    const handlers = this.eventHandlers[type] || [];
    handlers.forEach((handler) => handler(event));
  }

  send(event) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return;
    }
    this.pendingMessages.push(event);
  }
}
