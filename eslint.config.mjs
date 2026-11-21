import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["prompts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "max-len": [
        "error",
        {
          code: 80,
          comments: 80,
          tabWidth: 2,
          ignoreUrls: false,
          ignoreStrings: false,
          ignoreTemplateLiterals: false,
          ignoreComments: false,
        },
      ],
      "no-trailing-spaces": "error",
      "eol-last": ["error", "always"],
    },
  },
];
