# Model: 附件上传配置

## Model overview

本模型定义附件同步配置、对象 key 模板变量、附件筛选规则，以及附件从“本地引用”到“远端地址”再到“可选删除”的生命周期规则。

## Entities, fields, and enums

### `AttachmentSyncMode`

- `wiki` — 默认模式。附件按现有逻辑上传到 Confluence 页面，并将内容重写为 Wiki 附件 URL。
- `s3` — 命中规则的附件上传到 S3 兼容对象存储，并将内容重写为对象存储 URL。
- `wiki+s3` — 预留枚举。若首版不实现，可保留为文档级未来值，不进入代码默认值。

### `AttachmentSyncSettings`

- `mode: AttachmentSyncMode` — 附件同步目标模式。默认 `wiki`。
- `replaceLinksWhenS3: boolean` — S3 上传成功后是否回写原文链接。默认 `true`。
- `deleteLocalAfterUpload: boolean` — 上传与回写成功后是否删除本地附件。默认 `false`。
- `filePatterns: string[]` — 命中后执行 S3 上传的文件名模式列表，例如 `*.log`、`*.log.gz`、`*.tgz`。
- `pathPrefixTemplate: string` — 对象 key 前缀模板，例如 `{project}/{yyyy}/{MM}/{dd}`。
- `projectFieldName: string` — 从 frontmatter 读取项目名的字段名。默认 `project`。
- `defaultProject: string` — 当前文档缺少项目属性时的回退项目名。建议默认 `default`。
- `s3?: S3AttachmentSettings` — 当 `mode` 涉及对象存储时使用。

### `S3AttachmentSettings`

- `endpoint: string` — S3 兼容服务地址，例如 MinIO/OSS/RustFS 的接入 endpoint。
- `region: string` — 区域。对某些实现可选，但模型中保留。
- `bucket: string` — 目标桶名。
- `accessKeyId: string` — 访问 key。
- `secretAccessKey: string` — 密钥。
- `forcePathStyle: boolean` — 是否使用 path-style URL，兼容 MinIO 等实现。
- `publicBaseUrl?: string` — 可选公共访问地址前缀。存在时优先用于生成回写 URL。

### `AttachmentSyncCandidate`

- `sourceLink: string` — 文中原始匹配文本，例如 `![[server.log]]`。
- `resolvedFilePath: string` — 解析到的本地附件路径。
- `fileName: string` — 附件最终文件名。
- `mimeType: string` — 上传时使用的 MIME 类型。
- `target: wiki | s3` — 决策后的上传目标。
- `matchedPattern?: string` — 命中的文件规则。
- `renderedObjectKey?: string` — 若上传到对象存储，渲染出的最终 key。

### `AttachmentSyncResult`

- `uploadedCount: number` — 成功上传数量。
- `skippedCount: number` — 跳过数量。
- `rewrittenCount: number` — 成功回写链接数量。
- `deletedCount: number` — 成功删除本地文件数量。
- `errors: string[]` — 每个附件级错误或跳过原因。

## Relationships

- `AttachmentSyncSettings` 属于插件全局设置。
- `projectFieldName` 关联当前活动文档 frontmatter。
- `filePatterns` 影响 `AttachmentSyncCandidate.target` 的判定。
- `S3AttachmentSettings` 仅在对象存储相关模式下生效。

## State transitions or lifecycle

单个附件生命周期：

1. `Discovered`：从笔记中扫描到附件引用。
2. `Resolved`：成功定位到本地文件。
3. `Routed`：根据模式和文件规则决定目标 `wiki` 或 `s3`。
4. `Uploaded`：上传成功并获得目标 URL。
5. `Rewritten`：若要求回写，文档中的链接已替换并保存。
6. `DeletedLocal`：若启用删除，且前置步骤全部成功，本地文件被删除。
7. `Skipped` / `Failed`：任一步骤失败或因规则不匹配而跳过。

## Invariants and validation rules

- `mode = wiki` 时，可不提供 `s3` 配置。
- `mode = s3` 或 `wiki+s3` 时，`endpoint`、`bucket`、`accessKeyId`、`secretAccessKey` 必填。
- `deleteLocalAfterUpload = true` 必须依赖“上传成功 + 链接回写成功 + 文档保存成功”。
- `pathPrefixTemplate` 渲染后不得为空；最终对象 key 必须包含文件名。
- `filePatterns` 为空时，建议解释为“无文件命中 S3”，而不是“全部命中”，避免误传。
- `projectFieldName` 缺失对应 frontmatter 时，必须使用 `defaultProject` 回退，而不是直接失败。

## Storage or schema impact

- 插件持久化设置将新增 `attachmentSync` 配置块。
- 文档内容可能因 S3 回写发生变更。
- 本地附件文件可能被删除，但这是可选行为。
- 无数据库 schema 变化。

## Migration and compatibility notes

- 旧配置加载时缺少 `attachmentSync`，需自动补齐默认值并保持 `mode = wiki`。
- 旧文档中的附件链接无需迁移；只有执行新附件同步后，命中规则的链接才会被替换。
- 现有 Confluence 页面绑定、frontmatter 字段、页面同步逻辑保持兼容。

## Examples

### 示例 1：默认兼容模式

```json
{
  "attachmentSync": {
    "mode": "wiki",
    "replaceLinksWhenS3": true,
    "deleteLocalAfterUpload": false,
    "filePatterns": [],
    "pathPrefixTemplate": "{project}/{yyyy}/{MM}/{dd}",
    "projectFieldName": "project",
    "defaultProject": "default"
  }
}
```

### 示例 2：日志类附件走对象存储

```json
{
  "attachmentSync": {
    "mode": "s3",
    "replaceLinksWhenS3": true,
    "deleteLocalAfterUpload": true,
    "filePatterns": ["*.log", "*.log.gz", "*.tgz"],
    "pathPrefixTemplate": "{project}/{yyyy}/{MM}/{dd}",
    "projectFieldName": "project",
    "defaultProject": "default",
    "s3": {
      "endpoint": "https://minio.example.com",
      "region": "us-east-1",
      "bucket": "obsidian-attachments",
      "accessKeyId": "AKIA...",
      "secretAccessKey": "***",
      "forcePathStyle": true,
      "publicBaseUrl": "https://files.example.com/obsidian-attachments"
    }
  }
}
```

### 示例 3：模板渲染

- 文档 frontmatter: `project: billing`
- 日期: `2026-04-30`
- 文件名: `server.log.gz`
- 模板: `{project}/{yyyy}/{MM}/{dd}/{filename}`
- 输出 key: `billing/2026/04/30/server.log.gz`

## Open questions

- `filePatterns` 的匹配语义最终是否只支持 glob？
- `wiki+s3` 是否进入首版代码模型，还是仅保留文档扩展位？
- `publicBaseUrl` 缺失时，不同 S3 兼容后端的 URL 生成规则是否需要 provider 特化？
