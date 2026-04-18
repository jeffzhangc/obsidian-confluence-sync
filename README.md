# Confluence Sync Plugin

Sync Obsidian notes to Confluence 5.9.9+.

## Current Workflow

The plugin supports two sync modes:

- If the current note already has a bound Confluence page ID, sync overwrites that page.
- If the note has no binding, the plugin creates a new child page under the configured parent page, syncs the note, and stores the new page ID for later updates.

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

## Attachments

The plugin uploads local attachments to the target Confluence page and rewrites note links to Confluence attachment URLs.

### Supported File Types

All file types are supported:

- **Images**: png, jpg, jpeg, gif, bmp, svg, webp - displayed inline in Confluence
- **Documents**: pdf, doc, docx, xls, xlsx, ppt, pptx - shown as download links
- **Archives**: zip, tar, gz, 7z - shown as download links
- **Any other files** - shown as download links

### Link Format

Only Obsidian internal link format is processed:

```markdown
![[document.pdf]]
![[archive.zip]]
![[image.png]]
```

- **Images** are converted to `![alt](url)` format (displayed inline)
- **Other files** are converted to `[filename](url)` format (download link)

Standard Markdown image links `![alt](path)` are not processed to avoid external URL conflicts.

### Duplicate Detection

The plugin automatically detects existing attachments on the Confluence page:

- If an attachment with the same filename already exists, it will **not be re-uploaded**
- The existing attachment URL is reused, saving bandwidth and time
- This makes repeated syncs much faster when attachments haven't changed

Debug info shows: `Attachment skipped (already exists): filename.png (id: 12345)`

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
- If attachments are not appearing, check that the file exists in your vault and the link uses the correct `![[filename]]` format.
