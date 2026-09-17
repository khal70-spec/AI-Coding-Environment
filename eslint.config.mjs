// ESLint flat config — P3.5. Blocking gate (`npm run lint`).
// Sources are Node-strip-only TS — no transpiler; tests are plain .mjs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      ".local/**",
      "coverage/**",
      "dist/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
  })),
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      // Strip-only mode: 'erasable syntax only' — enforce globally visible rules
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/no-empty-object-type": "off",
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-throw-literal": "error",
      "prefer-const": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "eqeqeq": ["warn", "always", { null: "ignore" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
