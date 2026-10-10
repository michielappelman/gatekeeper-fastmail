import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        // For __tests__/hooks-worker.test.ts, which reaches the hook driver as deployed.
        durableObjects: {
          FastmailHookDriver: { className: "FastmailHookDriver", useSQLite: true },
          UserAccount: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
