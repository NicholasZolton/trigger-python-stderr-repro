# bug: python.runScript() deadlocks when Python subprocess produces >64KB stderr output

## Provide environment information

```
Binaries:
  Node: 22.x
  npm: 10.x
  Python: 3.13
```

Also reproduced in self-hosted environment on various runners. Hardware does not seem to affect it, and it was reproduced in both Linux and macOS.

## Describe the bug

`python.runScript()` from `@trigger.dev/python` permanently deadlocks the Python subprocess if it writes more than ~64KB to stderr. The Python process blocks on a `write()` syscall because nobody is reading from the other end of the stderr pipe yet.

This is a **silent, permanent hang** — no error, no timeout (unless `maxDuration` is set), no crash.

**Expected:** The Python subprocess completes and returns its stdout output.
**Actual:** The Python subprocess hangs indefinitely.

### Why this happens in practice

`runScript()` in `packages/python/src/index.ts` hardcodes `OTEL_LOG_LEVEL: "DEBUG"` in the Python subprocess environment (line 100), and spreads `...process.env` which leaks all parent OTEL vars. Any OTEL-aware Python library (e.g., `mlflow`, `opentelemetry-sdk`) picks these up and produces verbose debug-level log output to stderr during import. This easily exceeds the pipe buffer limit.

## Reproduction repo

https://github.com/NicholasZolton/trigger-python-stderr-repro

## To reproduce

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/NicholasZolton/trigger-python-stderr-repro.git
   cd trigger-python-stderr-repro
   npm install
   ```

2. Update `trigger.config.ts` with your project ref

3. Start the dev server:
   ```bash
   npx trigger.dev@4.4.3 dev
   ```

4. Trigger the task from the dashboard or via SDK:
   ```bash
   TRIGGER_SECRET_KEY=tr_dev_... node -e "
   const { tasks } = require('@trigger.dev/sdk/v3');
   tasks.trigger('stderr-deadlock-repro', {}).then(r => console.log(r.id));
   "
   ```

5. The task hangs indefinitely. It will only terminate when `maxDuration` (2 minutes) is reached.

The Python script is trivial — it just writes 300KB to stderr:

```python
import json, sys
sys.stderr.write("x" * 300_000)  # >64KB pipe buffer → deadlock
print(json.dumps({"ok": True}))  # never reached
```

## Additional information

### Root cause: tinyexec starts stderr drain lazily

The process hierarchy is:

```
Executor (packages/cli-v3/src/executions/taskRunProcess.ts)
  │  fork() with stdio: ["ignore", "pipe", "pipe", "ipc"]
  ▼
Worker (packages/cli-v3/src/entryPoints/dev-run-worker.ts)
  │  tinyexec x() with default stdio: ["ignore", "pipe", "pipe"]
  ▼
Python (grandchild process)
```

In `tinyexec`, `readStream(stderr)` is called inside `_waitForOutput()` (line 253 of `tinyexec/src/main.ts`), which only runs when `.then()` is called (line 293) — i.e., when the caller `await`s the result. The sequence is:

1. `x()` calls `spawn()` → Python starts and immediately writes to stderr
2. `x()` returns an `ExecProcess` to the caller
3. `await` triggers `.then()` → `_waitForOutput()` → `readStream(stderr)` starts draining

Between step 1 and step 3, there's a **microtask gap** where Python is writing to stderr but nobody is reading from the pipe. The pipe buffer on Linux is ~64KB (macOS ~65KB). If Python writes more than that before the drain starts, the `write()` syscall blocks and the process deadlocks permanently.

### Contributing issue: hardcoded `OTEL_LOG_LEVEL: "DEBUG"` in `@trigger.dev/python`

In `packages/python/src/index.ts`, `runScript()` sets the env as:

```typescript
env: {
  ...process.env,           // all parent OTEL_* vars leak in
  ...options.env,           // user's overrides
  TRACEPARENT: ...,
  OTEL_RESOURCE_ATTRIBUTES: ...,
  OTEL_LOG_LEVEL: "DEBUG",  // ← hardcoded AFTER user env, can't be overridden
},
```

This forces verbose OTEL debug logging in every Python subprocess. Combined with `...process.env` leaking `OTEL_EXPORTER_OTLP_ENDPOINT` (causing Python OTEL libraries to initialize tracing), this easily produces >64KB of stderr output during import — triggering the tinyexec deadlock.

Note: `OTEL_LOG_LEVEL: "DEBUG"` comes after `...options.env`, so even if the user passes `OTEL_LOG_LEVEL: ""` in their env options, the hardcoded value wins.

### Diagnosis on a production runner pod

We traced this using `/proc` forensics on a stuck runner pod:

**Process tree:**
```
PID 8:  node              (executor)           wchan=ep_poll
PID 19: trigger-dev-wor   (worker)             wchan=ep_poll
PID 30: python            (grandchild)         wchan=sock_alloc_send_pskb  ← STUCK
```

**Python's stderr — blocking, buffer full:**
```
fd 2 → socket (flags: 02, blocking)  ← blocked on write()
```

### Screenshot

The task hangs for the full `maxDuration` and is then cancelled:

![Trigger.dev dashboard showing the task hung for 1m 49s before being cancelled](https://raw.githubusercontent.com/NicholasZolton/trigger-python-stderr-repro/main/screenshot.png)

### Suggested fixes

#### Fix 1 (root cause): Start draining streams eagerly in tinyexec's `spawn()`

Currently `readStream()` is called lazily in `_waitForOutput()`. Moving it to `spawn()` ensures draining starts immediately when the process starts, eliminating the microtask gap:

```typescript
// tinyexec/src/main.ts — in spawn(), after setting up streams:
if (handle.stderr) {
  this._streamErr = handle.stderr;
  this._stderrPromise = readStream(handle.stderr);  // start draining NOW
}
if (handle.stdout) {
  this._streamOut = handle.stdout;
  this._stdoutPromise = readStream(handle.stdout);  // start draining NOW
}

// Then _waitForOutput() just awaits the already-running promises:
const [stdout, stderr] = await Promise.all([
  this._stdoutPromise ?? '',
  this._stderrPromise ?? ''
]);
```

This prevents the deadlock for any subprocess regardless of how much it writes to stderr.

#### Fix 2 (contributing cause): Remove hardcoded `OTEL_LOG_LEVEL` and filter OTEL env

In `packages/python/src/index.ts`:

1. Remove `OTEL_LOG_LEVEL: "DEBUG"` — it forces debug logging and can't be overridden
2. Filter `OTEL_*` vars from `process.env` before spreading — prevents Python libraries from picking up the executor's OTEL config
3. Let `...options.env` come last so users can override everything

We have a complete patch for this: [`suggested-fix.patch`](https://github.com/NicholasZolton/trigger-python-stderr-repro/blob/main/suggested-fix.patch)

### Our workaround

```typescript
// In the task's python.runScript() call
env: {
  OTEL_SDK_DISABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_LOG_LEVEL: "",  // note: this is actually overridden by the hardcoded value
}
```

```python
# At the top of our Python entrypoint, before any imports
if os.environ.get("TRIGGER_RUN_ID"):
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 2)
    os.close(devnull_fd)
    sys.stderr = open(2, "w")
```

This fixes the hang but means we lose all Python log output in the Trigger.dev dashboard.
