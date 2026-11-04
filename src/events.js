// Fan-out of live updates to every connected browser (laptop, phone, second
// screen on the LAN) over server-sent events.
import { EventEmitter } from "node:events";
import { saveState } from "./store.js";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/**
 * Persist and tell every client that state changed.
 * @param {string} reason short machine-readable cause, e.g. "approved"
 * @param {object} [extra] fields shown in toasts (merchant, amount, …)
 * @param {string} [origin] client id that caused it, so it can skip its own toast
 */
export function changed(reason, extra = {}, origin = null) {
  saveState();
  bus.emit("event", { type: "changed", reason, origin, ts: Date.now(), ...extra });
}
