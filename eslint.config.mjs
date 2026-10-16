import js from "@eslint/js";
import globals from "globals";

export default [
  {
    files: ["**/*.{js,mjs,cjs}"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], ignores: ["public/**"], languageOptions: { globals: globals.node } },
  { files: ["public/**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.browser } },
];
