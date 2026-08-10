// Minimal fake ChildProcess for testing runProcess() without spawning a
// real CLI. Tests drive it by calling .stdout/.stderr .emit('data', ...)
// and .emit('close', code) themselves.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.killSignals.push(signal);
    // Real processes eventually emit 'close' once the signal lands; mimic
    // that so runProcess()'s close-driven promise actually settles.
    if (!child.closeEmitted) {
      child.closeEmitted = true;
      queueMicrotask(() => child.emit("close", null));
    }
  };
  return child;
}
