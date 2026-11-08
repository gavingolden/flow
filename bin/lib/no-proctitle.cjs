// On macOS setting process.title registers the process with LaunchServices (~100 ms of system-daemon CPU per process; libuv#5300). This is a Node preload loaded via --require, not a Bun script, so it deviates from the bin/ Bun default.
try {
  const marker = Symbol.for("flow.noProctitle");
  if (process.platform === "darwin" && process[marker] !== true) {
    let current = process.title;
    Object.defineProperty(process, "title", {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(v) {
        current = String(v);
      },
    });
    process[marker] = true;
  }
} catch {}
