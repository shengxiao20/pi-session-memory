# Shared prompt resources

Edit Agent-facing text here. Keep tool registration and runtime logic in
`extensions/` and `src/`.

```text
prompts/
├── tools.ts           Tool text and command description
├── parameters.ts      Parameter descriptions; schemas stay at their call sites
├── guidance.ts        Setup, history, temporary-context, and consultation rules
├── configuration.ts   Configuration-field and environment-input help
├── models.ts          Historical consultant and Jev model text
├── responses.ts       Agent-facing setup response formats
└── setup.md           Sequential configuration guide
```

TypeScript modules use named exports and relative static imports. Text
formatters only insert supplied values. They do not read files, call services,
select participants, validate settings, or write history. Existing source
exports for shared notices re-export the same constants.

`src/setup/setup.ts` reads `prompts/setup.md` from the installed package.
Missing resources raise errors. There is no default-text fallback, runtime
template parser, or live reload. Restart Pi after changing installed resources.

The package includes `prompts/` and declares `pi.prompts: []`. This directory is
internal plugin data, not a set of Pi slash-command templates. The source
architecture map omits these shared resources. Dependency tests include them and
reject cycles or runtime imports.

## Format and lint

1. Run `npm run format` to format `prompts/` with Prettier.
2. Run `npm run lint` to check ESLint rules and Prettier formatting.
3. Run `npm test` to check text contracts and runtime behavior.

ESLint enforces 80 characters per TypeScript line, including strings, templates,
URLs, and comments. Prettier wraps Markdown prose at 80 characters. These
commands do not rewrite other source files or the independent experiment.

Prettier does not split long string literals. Use concatenated strings to fit
long text within 80 characters. Keep every space and newline unchanged:

```ts
export const EXAMPLE =
  "The first part ends with a space. " +
  "The second part continues the same text.";
```

Markdown formatting can change soft line breaks, but must preserve wording and
steps. TypeScript formatting must preserve every runtime text character.

## Text contracts

`tests/prompts.test.ts` checks the registered metadata and complete parameter
schemas against pre-extraction fingerprints. It also checks model formats, the
installed archive, and explicit missing-resource errors. For an intentional
wording change, review the new text and update the matching fingerprint in
`tests/fixtures/prompt-contract.json`. Do not update fingerprints only to bypass
an unexpected failure.
