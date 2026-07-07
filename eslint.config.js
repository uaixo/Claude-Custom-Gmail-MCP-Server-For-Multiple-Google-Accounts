// Flat ESLint config. TypeScript source gets the typescript-eslint
// type-checked recommended rules; the plain-JS test files get the core
// recommended rules. dist/ (build output) and node_modules/ are ignored.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        project: ["./tsconfig.json"],
        // Resolve the project relative to this config file (not the cwd) and
        // without import.meta.dirname, which is unavailable on Node 18 in CI.
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
  },
  {
    files: ["test/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // The smoke harness and this config are code too: an undefined identifier
    // in a fail-only branch of smoke-dist.mjs would otherwise ship green and
    // surface only when a real dist regression needs those diagnostics.
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  }
);
