import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".orbittrack-*/**",
  ]),
  {
    // The API test suite is intentionally loose-typed: it asserts on the JSON
    // shapes returned over HTTP, where `any` is the pragmatic type for "the
    // response body we just parsed." Allow it there only.
    files: ["tests/**", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Underscore-prefixed bindings (e.g. `_state`, `_prev`, `_formData`) are
    // intentional: useActionState requires the tuple even when only one half
    // is used. The prefix marks them as deliberately unused.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
