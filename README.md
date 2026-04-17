# Confluence Sync Plugin

Sync Obsidian notes to Confluence 5.9.9+.

## Current Workflow

The plugin supports two sync modes:

- If the current note already has a bound Confluence page ID, sync overwrites that page.
- If the current note has no binding, the plugin creates a new child page under the configured parent page, syncs the note, and stores the new page ID for later updates.

Each note gets a `uniqueId` in frontmatter so the Confluence binding survives file moves or renames. After a successful sync, the plugin also writes `confluenceUrl` back to frontmatter.

## Required Settings

Configure these values in the plugin settings:

- `Confluence Host`: for example `https://wiki.yuntongxun.com`
- `Username`
- `Password`
- `Parent Page ID`: the parent Confluence page used when a note has no existing binding

`Personal Access Token` is optional and only used as a fallback for newer Confluence servers.

## Commands

- `Sync contents of current page to Confluence`: create-or-update sync for the active note
- `Create new Confluence connection`: manually bind the active note to an existing Confluence page ID
- `Show last Confluence sync debug info`
- `Copy last Confluence sync debug info`

## Images

The plugin uploads local images to the target Confluence page as attachments, then rewrites note image links to Confluence attachment URLs.

Supported formats:

- Obsidian embeds such as `![[image.png]]`
- Markdown image links such as `![alt](./image.png)`

If an attachment upload fails, note content still syncs and the failure is recorded in the debug info.

## Build And Install

Build the plugin:

```bash
npm run build
```

The build output is written to `dist/`:

- `dist/main.js`
- `dist/manifest.json`
- `dist/styles.css`

Copy those files into your vault plugin directory:

```bash
cp -r ./dist/* /path/to/vault/.obsidian/plugins/confluence-sync/
```

## Troubleshooting

- If sync fails before page creation, verify that `Parent Page ID` still exists and is visible to the configured account.
- If sync fails, run `Copy last Confluence sync debug info` and inspect the exact request step, page ID, and error message.
