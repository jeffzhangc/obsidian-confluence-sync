# Confluence Sync Plugin

Sync Obsidian notes to Confluence 5.9.9+.

## Current Workflow

The plugin supports two sync modes:

- If the current note already has a bound Confluence page ID in frontmatter, sync overwrites that page.
- If the note has no binding, the plugin creates a new child page under the configured parent page, syncs the note, and stores the new page ID for later updates.

Each note stores its own binding in frontmatter. By default the plugin writes:

- `confluencePageId`: the Confluence page ID used for syncing
- `wiki`: the Confluence page URL for convenient direct use elsewhere

Both field names are configurable in plugin settings. Older notes that still use `uniqueId` + plugin `mapping` are migrated lazily the next time they are synced.

## Required Settings

Configure these values in the plugin settings:

- `Confluence Host`: for example `https://wiki.yuntongxun.com`
- `Username`
- `Password`
- `Parent Page ID`: the parent Confluence page used when a note has no existing binding

`Personal Access Token` is optional and only used as a fallback for newer Confluence servers.

## Commands

- `Sync contents of current page to Confluence`: create-or-update sync for the active note
- `Sync attachments of current page`: sync attachments only, optionally rewrite note links, and optionally delete local files after successful S3 upload
- `Create new Confluence connection`: manually bind the active note to an existing Confluence page ID
- `Show last Confluence sync debug info`
- `Copy last Confluence sync debug info`

## Attachments

The plugin uploads local attachments to the target Confluence page and rewrites note links to Confluence attachment URLs by default.

It also supports routing selected attachments to S3-compatible storage such as MinIO, OSS (S3-compatible endpoint), and RustFS.

### Attachment Sync Modes

- `wiki` (default): all processed attachments keep the current Confluence upload behavior
- `s3`: only attachments whose **filenames** match configured patterns are uploaded to S3-compatible storage and rewritten to remote URLs; all other attachments still go to Confluence

### S3-Compatible Attachment Settings

The settings tab includes:

- `Attachment mode`
- `Attachment file patterns`
- `Path template`
- `Project field name`
- `Default project`
- `Replace links when S3 upload succeeds`
- `Delete local files after upload`
- `S3 endpoint`
- `S3 region`
- `S3 bucket`
- `S3 access key`
- `S3 secret key`
- `Force path style`
- `Public base URL`

### Pattern Matching

Attachment filtering is **filename-only** and supports `*` wildcard matching:

- `*.log`
- `*.log.gz`
- `*.tgz`

Patterns can be separated by commas or new lines.

### Path Template Variables

The S3 object key template supports:

- `{project}`
- `{yyyy}`
- `{MM}`
- `{dd}`
- `{filename}`

Example:

```text
{project}/{yyyy}/{MM}/{dd}/{filename}
```

If a note does not define the configured project frontmatter field, the plugin falls back to `Default project`.

### Link Rewriting And Local Deletion

- S3 uploads rewrite note links to the generated remote URL when `Replace links when S3 upload succeeds` is enabled
- Local files are deleted only when all of these are true:
  - S3 upload succeeded
  - note link rewrite succeeded
  - note save succeeded
  - `Delete local files after upload` is enabled

### Supported File Types

All file types are supported:

- **Images**: png, jpg, jpeg, gif, bmp, svg, webp - displayed inline in Confluence
- **Documents**: pdf, doc, docx, xls, xlsx, ppt, pptx - shown as download links
- **Archives**: zip, tar, gz, 7z - shown as download links
- **Any other files** - shown as download links

### Link Format

Obsidian internal embeds and standard Markdown images are processed:

```markdown
![[document.pdf]]
![[archive.zip]]
![[image.png]]
![Local image](assets/image.png)
![Remote image](https://example.com/image.png)
```

- **Images** are converted to `![alt](url)` format (displayed inline)
- **Other files** are converted to `[filename](url)` format (download link)
- Local Markdown images are uploaded before page sync
- Remote `http/https` Markdown images are downloaded first, then uploaded to Confluence
- Remote images that fail due to network or auth limits are skipped and recorded in debug info

Standard Markdown links like `[text](path)` are still not processed.

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
