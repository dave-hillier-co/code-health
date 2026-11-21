import { EventEmitter } from "node:events";

export class Bus extends EventEmitter {}

export function announce(bus: Bus): void {
  bus.emit("announced");
}
