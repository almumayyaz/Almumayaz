class StorageEvents {
  constructor() {
    this._handlers = {
      beforeUpload: [],
      afterUpload: [],
      beforeDelete: [],
      afterDelete: [],
      uploadFailed: [],
      deleteFailed: []
    };
  }

  on(event, handler) {
    if (!this._handlers[event]) {
      throw new Error(`Unknown event: "${event}"`);
    }
    this._handlers[event].push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== handler);
  }

  async emit(event, data) {
    const handlers = this._handlers[event] || [];
    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (e) {
        console.error(`[storage-events] Error in ${event} handler:`, e.message);
      }
    }
  }

  clear() {
    for (const key of Object.keys(this._handlers)) {
      this._handlers[key] = [];
    }
  }
}

module.exports = { StorageEvents };
