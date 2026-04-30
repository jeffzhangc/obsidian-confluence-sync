# Specs Check: 附件上传配置与独立同步

## Metadata

- Spec: `docs/specs/202604_01_attachment-upload-config/spec.md`
- Branch: `feat/202604_01_attachment-upload-config`
- Date: 2026-04-30
- Reviewer: 张红亮
- Final decision: pass-with-follow-ups

## Plan

- Original goal: 为附件同步新增配置能力，默认保留 Wiki 上传，并支持 S3 兼容对象存储、链接回写、本地删除和独立附件同步命令。
- Scope: 实现插件内配置、S3 上传、正文回写、本地删除、独立命令，并同步更新文档。
- Target files: `main.ts`, `README.md`, `docs/specs/202604_01_attachment-upload-config/specs_check.md`
- Acceptance criteria: 默认 wiki 行为兼容；支持按文件名规则走 S3；支持独立附件同步命令；支持成功后回写与可选删除；构建通过。

## Do

- Implementation summary:
  - 在 `main.ts` 中新增附件同步配置模型、S3 兼容上传逻辑、文件名 glob-lite 匹配、路径模板渲染、独立附件同步命令。
  - 将附件处理重构为统一的 `runAttachmentSync` 流程，支持 wiki / s3 路由、正文回写和成功后的本地删除。
  - 扩展设置页，新增附件同步与 S3 兼容存储配置项。
  - 更新 `README.md` 说明命令、配置项、路径模板和删除条件。
- Commits / PR: TBD
- Files changed: `main.ts`, `README.md`, `docs/specs/202604_01_attachment-upload-config/specs_check.md`

## Check

- Automated tests: `rtk npm run build` 通过。
- Manual validation: 未在真实 Obsidian + S3 / Confluence 环境完成端到端验证。
- Acceptance criteria status: partial
- Deviations from spec:
  - 首版运行时仅支持 `wiki | s3` 两态，不实现 `wiki+s3` 独立模式值。
  - 文件过滤规则为文件名 glob-lite，仅支持 `*`，不支持正则。
  - S3 同 key 处理采用覆盖语义。
- Risks found:
  - S3 SigV4 为手写实现，仍需在 MinIO / OSS / RustFS 实测。
  - 本地删除依赖 Obsidian vault 删除行为，需在真实 vault 中确认用户体验。

## Act

- Follow-up tasks:
  - 在真实 MinIO / OSS / RustFS 环境验证 path-style 与 publicBaseUrl 行为。
  - 补充已回写远端链接再次执行时的回归验证。
  - 如用户需要，再补 `wiki+s3` 独立模式值与更丰富的匹配语义。
- Cleanup needed: 无
- Rollback decision: not-needed
- Release notes: 新增附件同步配置、S3 兼容上传、独立附件同步命令，以及成功后可选本地删除。

## Remaining Risks

- 不同 S3 兼容服务对签名、URL 风格和公开访问地址的兼容性仍需实测。
- 目前没有自动化测试覆盖附件重写与删除路径。
