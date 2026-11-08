import { EventEmitter } from 'node:events'

export interface BusEvent {
  type: string
  [key: string]: unknown
}

/** In-process fan-out for live updates (SSE). Keys are `space:<id>` or `user:<id>`. */
export class Bus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  publish(key: string, event: BusEvent): void {
    this.emitter.emit(key, event)
  }

  subscribe(key: string, listener: (event: BusEvent) => void): () => void {
    this.emitter.on(key, listener)
    return () => this.emitter.off(key, listener)
  }
}
