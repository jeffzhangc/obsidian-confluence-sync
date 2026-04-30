# 附件上传配置与独立同步

## Metadata

- Status: Draft
- Date: 2026-04-30
- Owner: 张红亮
- Type: feat
- Branch: `feat/202604_01_attachment-upload-config`
- Directory: `docs/specs/202604_01_attachment-upload-config/`
- Sequence: 01
- Companion docs: model.md

## Background

当前插件会在内容同步到 Confluence 时，扫描笔记中的 `![[...]]` 附件引用，将本地附件上传到目标 Confluence 页面，并把文中的附件引用重写为 Confluence 附件下载地址。该能力已经支持所有文件类型，并对同名附件做重复检测。

## Problem / Reason

当前附件同步只有单一路径：上传到 Confluence/Wiki。用户希望把附件同步策略做成可配置：

- 默认仍同步到 Wiki，保持现有使用习惯。
- 可配置 S3 兼容对象存储地址，把指定附件上传到云端。
- 在上传到 S3/兼容存储后，将原文中的附件地址替换为云端 URL。
- 可配置上传成功后删除本地附件文件，减少仓库或本地库体积。
- 可通过路径模板组织云端对象 key，例如 `{project}/{yyyy}/{MM}/{dd}/文件名`。
- 可按文件名规则筛选需要云同步的附件，例如 `*.log`、`*.log.gz`、`*.tgz`。
- 需要独立命令执行“附件同步”，而不是只能在整篇页面同步时顺带执行。

如果没有该能力，用户只能继续把所有附件上传到 Wiki，无法把日志、压缩包等更适合对象存储的附件迁移到 MinIO、OSS、RustFS 等 S3 兼容后端，也无法自动回写外链与清理本地文件。

## Goals

- 保持默认行为兼容：未开启新配置时，附件继续同步到 Wiki。
- 新增附件上传目标配置，支持 Wiki 与 S3 兼容对象存储两类目标。
- 支持 S3 兼容后端接入，包括 AWS S3、MinIO、阿里云 OSS（S3 兼容模式）、RustFS 等。
- 支持通过路径前缀模板生成对象存储 key，并可从文档属性中读取 `project` 变量。
- 支持按文件名模式过滤哪些附件上传到对象存储。
- 支持上传到对象存储后回写笔记中的附件链接。
- 支持上传成功后按配置删除本地附件。
- 新增独立“附件同步”命令，允许不执行整页 Wiki 内容同步。
- 为失败、跳过、删除、回写等关键步骤补充调试信息。

## Non-goals

- 不在本期支持非 S3 协议的专有云存储接口。
- 不在本期支持双向同步或从云端回拉附件。
- 不在本期支持基于文件内容 hash 的跨路径去重。
- 不在本期支持监听文件系统自动后台同步附件。
- 不在本期处理标准 Markdown 外链 `![alt](path)` 的全量重写范围扩展，除非实现过程中确认复用现有解析不会引入冲突。

## Current Behavior

- 插件设置仅包含 Confluence 连接和 frontmatter 字段配置，未提供附件目标、S3、删除策略、过滤规则等设置。
- `main.ts:134` 的主同步命令会在页面同步前调用 `uploadAttachmentsAndRewriteContent`。
- `main.ts:559` 的附件处理逻辑仅解析 `![[...]]` 格式附件链接。
- `main.ts:679` 的上传逻辑只面向 Confluence 附件接口；若页面上已有同名附件则直接复用已有 URL。
- 附件上传是页面同步流程的一个子步骤，暂无独立命令。
- 当前不会删除本地附件，也不会把附件改为 S3/兼容存储地址。

## Proposed Design

### 1. 新增附件同步配置模型

在插件设置中新增 `attachmentSync` 配置块，至少包含：

- `mode`: 附件同步模式。
  - `wiki`：默认值，保持当前行为。
  - `s3`：上传到 S3 兼容存储，并按配置回写链接。
  - `wiki+s3`：可选扩展模式；本期文档先保留结构支持，默认仍为 `wiki`。若实现复杂度过高，可在首版降级为 `wiki` / `s3` 两态，并在开放问题中注明。
- `replaceLinksWhenS3`: 是否仅在 S3 上传成功后回写原文链接。默认 `true`。
- `deleteLocalAfterUpload`: 是否在上传成功且链接回写成功后删除本地附件。默认 `false`。
- `filePatterns`: 文件名匹配规则列表，命中后才执行 S3 上传；未命中时继续走 Wiki 流程。
- `pathPrefixTemplate`: 对象 key 前缀模板，默认建议为 `{project}/{yyyy}/{MM}/{dd}`。
- `projectFieldName`: 从文档 frontmatter 读取项目名的字段名，默认 `project`。
- `s3`: S3 兼容配置，见 `model.md`。

### 2. 默认行为兼容策略

- 当 `attachmentSync.mode = wiki` 或未配置附件同步能力时，沿用当前实现，不改变现有用户体验。
- 当启用 S3 模式后：
  - 仅匹配到 `filePatterns` 的附件走对象存储上传。
  - 未匹配附件仍走 Wiki 上传，避免影响图片内联展示等现有能力。
- “Wiki 优先”解释为：默认模式是 `wiki`；只有用户显式配置 S3 后，命中的文件才会改为对象存储目标。

### 3. S3 兼容上传与链接生成

新增对象存储上传器，使用 S3 兼容 API 完成：

- endpoint、region、bucket、accessKey、secretKey、forcePathStyle 等从设置读取。
- 通过模板拼接对象 key：
  - 支持变量 `{project}`、`{yyyy}`、`{MM}`、`{dd}`、`{filename}`。
  - `project` 从当前文档 frontmatter 读取；缺失时使用 `defaultProject` 或回退值 `default`。
- 上传成功后生成可公开访问或可拼接的对象 URL：
  - 优先使用显式配置的 `publicBaseUrl`。
  - 否则基于 endpoint + bucket + key 生成访问地址。
- 对象 key 冲突策略首版采用“同 key 覆盖”或“已存在则直接复用”二选一，具体以实现阶段可控性为准；需在开放问题中确认。

### 4. 附件扫描与回写规则

- 保留当前对 `![[...]]` 附件引用的扫描能力。
- 对每个解析到的附件：
  1. 解析目标文件。
  2. 根据 `filePatterns` 判断是否需要走 S3。
  3. 若走 Wiki：复用当前逻辑。
  4. 若走 S3：上传对象存储并拿到最终 URL。
  5. 若 `replaceLinksWhenS3 = true`，把原文中的 `![[...]]` 或附件链接替换为云端 URL。
  6. 若 `deleteLocalAfterUpload = true`，且回写成功，再删除本地文件。
- 删除必须放在“上传成功 + 链接回写成功 + 文档保存成功”之后，避免数据丢失。

### 5. 独立附件同步命令

新增单独命令，例如：

- `Sync attachments of current page`

行为：

- 只处理当前活动笔记中的附件扫描、上传、链接回写、可选删除。
- 不执行 Confluence 页面创建/更新。
- 当模式为 `wiki` 且附件仍需依赖 pageId 时，若当前笔记没有已绑定的 Confluence pageId，则给出明确提示，避免无法确定上传目标。
- 当模式为 `s3` 且无需 Wiki pageId 时，允许在未绑定 Confluence 页面的情况下独立执行。

### 6. 设置页调整

在 `main.ts:968` 的设置页新增附件相关设置区块：

- 附件同步模式
- S3 endpoint / region / bucket / accessKey / secretKey
- publicBaseUrl / forcePathStyle
- pathPrefixTemplate
- projectFieldName
- filePatterns
- replaceLinksWhenS3
- deleteLocalAfterUpload

敏感信息（如 secretKey）继续作为本地插件设置保存，不写入文档内容。

### 7. 调试与可观测性

扩展现有 `lastSyncDebugInfo`：

- 附件命中规则
- 上传目标（wiki/s3）
- 对象 key
- 链接回写结果
- 本地删除结果
- 跳过原因（未命中规则、缺少 project、缺少 bucket、未绑定 pageId 等）

## Model Design

需要单独的 `model.md`，因为该功能新增了一组稳定的配置结构、路径模板变量、文件筛选规则与附件生命周期规则。

## API Design

本次不需要单独 `api.md`。

原因：

- 用户可见的接口主要是插件设置项和 Obsidian 命令，不涉及外部 HTTP API 契约设计。
- S3 与 Confluence 都复用既有远端接口调用方式，当前 spec 重点在本地配置与处理流程，而不是对外暴露新协议。

## Implementation Plan

1. 扩展设置模型与默认值，增加附件同步模式、S3 配置、路径模板、文件匹配与删除策略。
2. 在设置页新增附件同步配置 UI，并对必填项与模式切换做基础校验。
3. 抽离附件上传决策逻辑：区分 Wiki 上传与 S3 上传，并保留当前 Wiki 逻辑兼容。
4. 实现对象 key 模板渲染、frontmatter `project` 读取、文件名模式匹配。
5. 实现 S3 兼容上传器与云端 URL 生成逻辑。
6. 在附件同步成功后实现原文链接回写，并在配置启用时执行本地删除。
7. 新增独立附件同步命令，并根据目标模式处理 pageId 依赖。
8. 补充调试日志、手工验证路径与 README/设置说明。

## Risks

- 误删本地附件导致数据不可恢复。
  - 缓解：仅在上传成功、回写成功、文档保存成功后删除；默认关闭删除开关。
- S3 兼容实现差异导致部分厂商不兼容。
  - 缓解：优先选用标准 S3 兼容客户端或最小兼容参数集，首版明确支持范围。
- 文件名模式或路径模板配置错误，导致对象 key 不符合预期。
  - 缓解：在设置页提供示例说明，并在调试日志中输出最终 key。
- 仅替换命中的附件链接，可能导致同一文档中附件目标混用。
  - 缓解：这是有意设计，用于区分图片继续走 Wiki、日志包走 S3。
- 独立附件同步在 `wiki` 模式下缺失 pageId。
  - 缓解：提前校验并直接提示用户先完成页面绑定。

## Tradeoffs

- 选择“按文件模式决定 S3 上传”，而不是所有附件统一切换目标。
  - 好处：兼容图片内联与大文件分流。
  - 代价：实现与调试复杂度更高。
- 选择“仅在 S3 上传时替换原文链接”。
  - 好处：最大程度保持现有 Wiki 同步行为不变。
  - 代价：两种附件目标共存时，文档中的链接形式可能不完全一致。
- 选择“删除本地文件作为显式开关”。
  - 好处：安全。
  - 代价：需要用户额外配置与理解行为边界。

## Pros and Cons

### Pros

- 默认兼容现有 Wiki 附件同步流程。
- 支持把日志、压缩包等附件迁移到更适合的对象存储。
- 兼容多种 S3 兼容后端，部署灵活。
- 路径模板与 `project` 变量使对象存储目录更可控。
- 独立附件同步命令可支持“先传附件，再决定是否同步页面”。

### Cons

- 配置项明显增加，设置页复杂度上升。
- 本地删除能力存在误操作风险。
- 对象存储公共访问地址生成在不同厂商下可能需要额外兼容。

## Testing and Validation

- Automated tests
  - 运行 `npm run build`，确保类型检查和构建通过。
  - 若实现中抽出纯函数，优先为模板渲染、文件匹配、key 生成补充单元测试。
- Manual validation
  - 在默认 `wiki` 模式下同步含图片和压缩包的笔记，验证行为与当前版本一致。
  - 配置 MinIO/OSS/RustFS 其中一种 S3 兼容存储，验证命中 `*.log`、`*.log.gz`、`*.tgz` 的附件上传成功。
  - 验证未命中规则的图片仍上传到 Wiki 并在 Confluence 中可访问。
  - 验证启用 `replaceLinksWhenS3` 后，文档中的附件链接被改写为对象存储 URL。
  - 验证启用 `deleteLocalAfterUpload` 后，本地文件仅在成功路径下被删除。
  - 验证独立附件同步命令在 `s3` 模式可单独执行，在 `wiki` 模式无 pageId 时给出提示。
- Acceptance criteria
  - 未配置新能力时，现有页面与附件同步行为不变。
  - S3 模式可根据规则上传附件并回写 URL。
  - 删除本地附件是显式开关，默认关闭。
  - 独立附件同步命令可用。

## Rollback Plan

- 若上线后出现兼容或误删风险，可通过将 `attachmentSync.mode` 切回 `wiki` 并关闭删除开关立即停用新能力。
- 如代码层面需要回滚，可移除新增附件配置与独立命令，恢复现有 `uploadAttachmentsAndRewriteContent` 单路径实现。
- 因为默认行为保持 `wiki`，回滚不涉及已有文档 frontmatter 迁移。
- 已被替换为对象存储 URL 的文档内容属于数据层变更；若需要回退，应由后续工具或脚本按记录恢复，本期不自动处理历史回滚。

## Open Questions

- `wiki+s3` 双写模式是否进入首版，还是先仅支持 `wiki` 与 `s3` 两态？
- 对象存储已存在同 key 文件时，采用覆盖、跳过复用，还是重命名追加后缀？
- 文件名规则是使用 glob 语法、正则表达式，还是两者都支持？当前用户示例更接近 glob。
- 对于已替换为 S3 URL 的历史链接，后续再次执行附件同步时是否需要跳过、校验或更新？
- `project` 缺失时的回退策略是否固定为 `default`，还是应允许用户单独配置默认项目名？
