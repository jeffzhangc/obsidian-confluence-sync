# Repository Guidelines

## Project Structure & Module Organization

This repository is a small Obsidian plugin rather than a multi-package app. Core logic lives in `main.ts`, which defines the plugin, commands, modal UI, and settings tab. Plugin metadata is stored in `manifest.json`, supported app versions in `versions.json`, and release version updates in `version-bump.mjs`. Build configuration lives in `esbuild.config.mjs`, TypeScript settings in `tsconfig.json`, and plugin styling in `styles.css`.

## Build, Test, and Development Commands

- `npm install`: install local dependencies from `package-lock.json`.
- `npm run dev`: run the esbuild watcher for local plugin development.
- `npm run build`: type-check with `tsc -noEmit -skipLibCheck` and produce the production bundle.
- `npm run version`: bump plugin metadata and stage `manifest.json` plus `versions.json` for release commits.

For local Obsidian testing, build the plugin and load this folder into an Obsidian vault's `.obsidian/plugins/` directory.

## Coding Style & Naming Conventions

Use TypeScript with the existing tab-indented style shown in `main.ts`. Keep classes in `PascalCase`, methods and variables in `camelCase`, and constants such as `DEFAULT_SETTINGS` in `UPPER_SNAKE_CASE`. Follow the current pattern of grouping Obsidian imports at the top and keeping plugin-facing strings explicit. The repository does not currently include Prettier or ESLint scripts, so keep changes small and consistent with the surrounding file.

## Testing Guidelines

There is no automated test suite yet. At minimum, verify changes by running `npm run build` and exercising the plugin in Obsidian: create a connection, update settings, and sync a note with `uniqueId` frontmatter. When adding logic-heavy helpers, prefer extracting them into small functions so future unit tests are easy to add.

## Commit & Pull Request Guidelines

Recent history uses short, imperative subjects such as `removed default value for confluence host` and `upgrade version`. Keep commit messages concise, focused on one change, and lowercase if you follow the existing style. For pull requests, include a short summary, note any manifest or version changes, list manual verification steps, and attach screenshots only when UI text or settings screens change.

## Security & Configuration Tips

Do not commit real Confluence hosts, page IDs, or personal access tokens. Treat `personalAccessToken` values as secrets and verify any sample configuration uses placeholders only.
