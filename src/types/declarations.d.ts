declare module 'ws' {
  import { EventEmitter } from 'events';
  class WebSocket extends EventEmitter {
    static OPEN: number;
    static CLOSED: number;
    static CLOSING: number;
    static CONNECTING: number;
    readyState: number;
    constructor(address: string, options?: any);
    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    removeAllListeners(event?: string | symbol): this;
    ping(): void;
  }
  export = WebSocket;
}
