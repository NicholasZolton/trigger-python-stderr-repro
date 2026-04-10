"""
Reproduction script for python.runScript() stderr deadlock.

python.runScript() connects stderr to a blocking Unix socketpair with a
~208KB kernel buffer (net.core.wmem_default = 212992). If the Python process
writes more than this to stderr before the trigger-dev-worker intermediary
drains it, the write() syscall blocks forever in sock_alloc_send_pskb.

This script writes 300KB to stderr — enough to fill the buffer and deadlock.
The final print() to stdout is never reached.
"""

import json
import sys

# Write more than the ~208KB Unix socket buffer to stderr.
# This simulates what happens when heavy Python libraries (numpy, sklearn,
# mlflow) produce log output during import — especially when the inherited
# OTEL_LOG_LEVEL=DEBUG env var causes verbose OpenTelemetry debug logging.
BYTES_TO_WRITE = 300_000  # ~300KB, well over the ~208KB buffer limit

sys.stderr.write("x" * BYTES_TO_WRITE)
sys.stderr.flush()

# This line is never reached — the process is deadlocked on the stderr write above.
print(json.dumps({"ok": True, "message": "This should never print"}))
