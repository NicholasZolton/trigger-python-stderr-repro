import { pythonExtension } from "@trigger.dev/python/extension";
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_btibqwhzxtolizlbgxmu",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  dirs: ["trigger"],
  build: {
    extensions: [
      pythonExtension({
        scripts: ["scripts/**/*.py"],
        devPythonBinaryPath: "/usr/bin/python3",
      }),
    ],
  },
});
