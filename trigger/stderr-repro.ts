import { python } from "@trigger.dev/python";
import { task } from "@trigger.dev/sdk/v3";

/**
 * Reproduces a deadlock in python.runScript() when the Python subprocess
 * writes more than ~208KB to stderr.
 *
 * Expected: task completes with {"ok": true}
 * Actual:   task hangs indefinitely — Python is blocked on stderr write
 *
 * Diagnosis on the runner pod:
 *   cat /proc/{python_pid}/task/star/wchan -> "sock_alloc_send_pskb"
 *   ls -la /proc/{python_pid}/fd/2        -> blocking Unix socketpair
 */
export const stderrReproTask = task({
  id: "stderr-deadlock-repro",
  retry: { maxAttempts: 1 },
  maxDuration: 120, // 2 minutes — will timeout if deadlocked
  run: async (): Promise<{ ok: boolean }> => {
    const result = await python.runScript("scripts/repro.py", []);

    const parsed = JSON.parse(result.stdout) as { ok: boolean; message: string };
    console.log("Python result:", parsed);

    return { ok: parsed.ok };
  },
});
