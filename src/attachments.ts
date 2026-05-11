import { requestUrl, TFile } from 'obsidian';
import { IMAGE_EXTENSIONS, MARKDOWN_IMAGE_REGEX, WIKI_ATTACHMENT_REGEX } from './constants';
import { readFrontmatterValue } from './frontmatter';
import { ConfluenceAttachment, ConfluenceService } from './confluence';
import { S3Service } from './s3';
import { ObsidianConfluenceSyncSettings } from './settings';

export interface AttachmentReference {
	kind: 'wiki' | 'markdown-image';
	fullMatch: string;
	rawTarget: string;
	attachmentPath: string;
	altText: string;
	index: number;
	occurrence: number;
}

export interface AttachmentSyncCandidate {
	reference: AttachmentReference;
	file: TFile;
	target: 'wiki' | 's3';
	matchedPattern: string | null;
	objectKey: string;
}

export interface RemoteImageResource {
	filename: string;
	mimeType: string;
	binaryContents: ArrayBuffer;
}

export interface AttachmentSyncRunResult {
	localContent: string;
	confluenceContent: string;
	uploadedCount: number;
	skippedCount: number;
	rewrittenCount: number;
	deletedCount: number;
	errors: string[];
}

export function normalizeFilePatterns(patterns: string[] | string | undefined): string[] {
	if (typeof patterns === 'string') {
		return patterns.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean);
	}
	return (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
}

export class AttachmentSyncService {
	constructor(
		private readonly app: any,
		private readonly getSettings: () => ObsidianConfluenceSyncSettings,
		private readonly appendDebugInfo: (lines: string[]) => void,
		private readonly formatError: (error: unknown, requestUrlValue?: string) => string,
		private readonly confluenceService: ConfluenceService,
		private readonly s3Service: S3Service
	) {}

	async runAttachmentSync(activeFile: TFile, rawContent: string, pageId: string | undefined, persistLocalRewrites: boolean): Promise<AttachmentSyncRunResult> {
		const validationErrors = this.validateAttachmentSyncSettings();
		if (validationErrors.length > 0) throw new Error(validationErrors[0]);
		const references = this.extractAttachmentReferences(rawContent);
		let localContent = rawContent;
		let confluenceContent = rawContent;
		let uploadedCount = 0;
		let skippedCount = 0;
		let rewrittenCount = 0;
		let deletedCount = 0;
		const errors: string[] = [];
		const deleteCandidates = new Map<string, TFile>();
		const existingAttachments = pageId ? await this.confluenceService.getExistingAttachments(pageId) : new Map<string, ConfluenceAttachment>();
		this.appendDebugInfo([`Attachment references found: ${references.length}`]);

		for (const reference of references) {
			try {
				if (this.isRemoteImageReference(reference)) {
					if (!pageId) {
						throw new Error(`Remote image ${reference.attachmentPath} requires a bound Confluence page before it can sync to wiki.`);
					}
					const remoteImage = await this.downloadRemoteImage(reference.attachmentPath);
					this.appendDebugInfo([
						`Remote image downloaded: ${reference.attachmentPath}`,
						`Remote image filename: ${remoteImage.filename}`,
						`Remote image mime type: ${remoteImage.mimeType}`
					]);
					const url = await this.confluenceService.uploadBinaryAttachmentAndGetUrl(pageId, remoteImage.filename, remoteImage.mimeType, remoteImage.binaryContents, existingAttachments);
					uploadedCount += 1;
					const replacement = `![${reference.altText}](${url})`;
					if (replacement !== reference.fullMatch) {
						confluenceContent = this.replaceNthMatch(confluenceContent, reference.fullMatch, replacement, reference.occurrence);
					}
					continue;
				}

				const file = this.resolveFile(activeFile, reference.attachmentPath);
				if (!file) {
					skippedCount += 1;
					errors.push(`Missing attachment: ${reference.attachmentPath}`);
					this.appendDebugInfo([`Attachment skipped: ${reference.attachmentPath}`, 'Reason: file could not be resolved']);
					continue;
				}

				const candidate = this.buildAttachmentSyncCandidate(activeFile, reference, file);
				this.appendDebugInfo([
					`Attachment found: ${file.path}`,
					`Attachment target: ${candidate.target}`,
					`Attachment pattern: ${candidate.matchedPattern ?? '(none)'}`,
					`Attachment object key: ${candidate.objectKey || '(n/a)'}`
				]);

				if (candidate.target === 'wiki' && !pageId) {
					throw new Error(`Attachment ${file.name} requires a bound Confluence page before it can sync to wiki.`);
				}

				const url = candidate.target === 's3'
					? await this.s3Service.uploadAttachmentToS3(file, candidate.objectKey)
					: await this.confluenceService.uploadAttachmentAndGetUrl(pageId as string, file, existingAttachments);
				uploadedCount += 1;
				const replacement = this.buildAttachmentReplacement(candidate, url);
				if (replacement === reference.fullMatch) continue;
				confluenceContent = this.replaceNthMatch(confluenceContent, reference.fullMatch, replacement, reference.occurrence);
				if (candidate.target === 's3' && this.getSettings().attachmentSync.replaceLinksWhenS3) {
					localContent = this.replaceNthMatch(localContent, reference.fullMatch, replacement, reference.occurrence);
					rewrittenCount += 1;
					if (this.getSettings().attachmentSync.deleteLocalAfterUpload) {
						deleteCandidates.set(file.path, file);
					}
				}
			} catch (error) {
				skippedCount += 1;
				const message = this.formatError(error);
				errors.push(`Attachment ${reference.attachmentPath}: ${message}`);
				this.appendDebugInfo([`Attachment upload skipped: ${reference.attachmentPath}`, `Attachment error: ${message}`]);
			}
		}

		if (persistLocalRewrites && localContent !== rawContent) {
			await this.persistRewrittenNote(activeFile, localContent);
			this.appendDebugInfo(['Attachment rewrite saved: yes']);
		}

		if (this.getSettings().attachmentSync.deleteLocalAfterUpload && localContent !== rawContent) {
			for (const file of deleteCandidates.values()) {
				try {
					await this.deleteLocalAttachment(file);
					deletedCount += 1;
					this.appendDebugInfo([`Attachment deleted locally: ${file.path}`]);
				} catch (error) {
					const message = this.formatError(error);
					errors.push(`Delete ${file.name}: ${message}`);
					this.appendDebugInfo([`Attachment delete skipped: ${file.path}`, `Delete error: ${message}`]);
				}
			}
		}

		return { localContent, confluenceContent, uploadedCount, skippedCount, rewrittenCount, deletedCount, errors };
	}

	validateAttachmentSyncSettings(): string[] {
		const errors: string[] = [];
		const attachmentSettings = this.getSettings().attachmentSync;
		if (attachmentSettings.deleteLocalAfterUpload && !attachmentSettings.replaceLinksWhenS3) {
			errors.push('Delete local attachments requires replacing links when S3 upload succeeds.');
		}
		if (attachmentSettings.mode === 's3') {
			errors.push(...this.validateS3Settings());
		}
		return errors;
	}

	validateS3Settings(): string[] {
		const s3 = this.getSettings().attachmentSync.s3;
		const errors: string[] = [];
		if (!s3.endpoint.trim()) errors.push('S3 endpoint is required when attachment mode is s3.');
		if (!s3.bucket.trim()) errors.push('S3 bucket is required when attachment mode is s3.');
		if (!s3.accessKeyId.trim()) errors.push('S3 access key is required when attachment mode is s3.');
		if (!s3.secretAccessKey.trim()) errors.push('S3 secret key is required when attachment mode is s3.');
		return errors;
	}

	buildAttachmentSyncCandidate(activeFile: TFile, reference: AttachmentReference, file: TFile): AttachmentSyncCandidate {
		const matchedPattern = this.findMatchingPattern(file.name);
		const target = this.getSettings().attachmentSync.mode === 's3' && matchedPattern ? 's3' : 'wiki';
		return { reference, file, target, matchedPattern, objectKey: target === 's3' ? this.renderObjectKey(activeFile, file.name) : '' };
	}

	extractAttachmentReferences(content: string): AttachmentReference[] {
		const references: AttachmentReference[] = [];
		const occurrenceCounts = new Map<string, number>();

		for (const match of content.matchAll(WIKI_ATTACHMENT_REGEX)) {
			const rawTarget = match[1];
			const segments = rawTarget.split('|').map((item) => item.trim());
			const attachmentPath = segments[0];
			const fullMatch = match[0];
			const occurrence = occurrenceCounts.get(fullMatch) ?? 0;
			occurrenceCounts.set(fullMatch, occurrence + 1);
			references.push({
				kind: 'wiki',
				fullMatch,
				rawTarget,
				attachmentPath,
				altText: segments.slice(1).join(' ') || attachmentPath,
				index: match.index ?? 0,
				occurrence
			});
		}

		for (const match of content.matchAll(MARKDOWN_IMAGE_REGEX)) {
			const altText = (match[1] ?? '').trim();
			const rawTarget = (match[2] ?? '').trim();
			const fullMatch = match[0];
			const occurrence = occurrenceCounts.get(fullMatch) ?? 0;
			occurrenceCounts.set(fullMatch, occurrence + 1);
			references.push({
				kind: 'markdown-image',
				fullMatch,
				rawTarget,
				attachmentPath: this.normalizeMarkdownImagePath(rawTarget),
				altText,
				index: match.index ?? 0,
				occurrence
			});
		}

		return references.sort((left, right) => left.index - right.index);
	}

	buildAttachmentReplacement(candidate: AttachmentSyncCandidate, url: string): string {
		return this.isImageFile(candidate.file) ? `![${candidate.reference.altText}](${url})` : `[${candidate.reference.altText}](${url})`;
	}

	replaceNthMatch(content: string, target: string, replacement: string, occurrence: number): string {
		if (occurrence < 0) return content;
		let fromIndex = 0;
		let matchIndex = 0;
		while (true) {
			const foundAt = content.indexOf(target, fromIndex);
			if (foundAt === -1) return content;
			if (matchIndex === occurrence) {
				return `${content.slice(0, foundAt)}${replacement}${content.slice(foundAt + target.length)}`;
			}
			fromIndex = foundAt + target.length;
			matchIndex += 1;
		}
	}

	persistRewrittenNote(activeFile: TFile, content: string): Promise<void> {
		return this.app.vault.modify(activeFile, content);
	}

	async deleteLocalAttachment(file: TFile): Promise<void> {
		await this.app.vault.delete(file, true);
	}

	resolveFile(activeFile: TFile, targetPath: string): TFile | null {
		const normalizedTarget = this.normalizeLocalTargetPath(targetPath);
		if (!normalizedTarget) return null;
		const linkedFile = this.app.metadataCache.getFirstLinkpathDest(normalizedTarget, activeFile.path);
		if (linkedFile instanceof TFile) return linkedFile;
		const decodedTarget = decodeURIComponent(normalizedTarget.replace(/^<|>$/g, ''));
		const directFile = this.app.vault.getAbstractFileByPath(decodedTarget);
		return directFile instanceof TFile ? directFile : null;
	}

	isImageFile(file: TFile): boolean {
		return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
	}

	isRemoteImageReference(reference: AttachmentReference): boolean {
		return reference.kind === 'markdown-image' && /^https?:\/\//i.test(reference.attachmentPath);
	}

	normalizeMarkdownImagePath(rawTarget: string): string {
		const trimmed = rawTarget.trim();
		const wrapped = trimmed.match(/^<(.+)>$/);
		const unwrapped = wrapped ? wrapped[1].trim() : trimmed;
		const titleMatch = unwrapped.match(/^(\S+)(?:\s+["'][^"']*["'])$/);
		return titleMatch ? titleMatch[1] : unwrapped;
	}

	normalizeLocalTargetPath(targetPath: string): string {
		const withoutFragment = targetPath.split('#')[0].trim();
		const withoutQuery = withoutFragment.split('?')[0].trim();
		return withoutQuery;
	}

	async downloadRemoteImage(url: string): Promise<RemoteImageResource> {
		const response = await requestUrl({ url, method: 'GET' });
		if (response.status >= 400) {
			throw new Error(`Remote image download failed. HTTP ${response.status}. URL: ${url}`);
		}
		const mimeType = this.normalizeMimeType(response.headers['content-type']);
		const filename = this.buildRemoteImageFilename(url, mimeType);
		return {
			filename,
			mimeType,
			binaryContents: response.arrayBuffer
		};
	}

	normalizeMimeType(contentTypeHeader: string | string[] | undefined): string {
		const raw = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
		return raw?.split(';')[0].trim() || 'application/octet-stream';
	}

	buildRemoteImageFilename(url: string, mimeType: string): string {
		let pathname = '';
		try {
			pathname = new URL(url).pathname;
		} catch (_error) {
			pathname = '';
		}
		const lastSegment = pathname.split('/').filter(Boolean).pop() ?? '';
		const decodedName = lastSegment ? decodeURIComponent(lastSegment) : '';
		const safeName = decodedName.replace(/[\\/:*?"<>|]/g, '-').trim();
		if (safeName) {
			if (safeName.includes('.')) return safeName;
			const extension = this.mimeTypeToExtension(mimeType);
			return extension ? `${safeName}.${extension}` : safeName;
		}
		const extension = this.mimeTypeToExtension(mimeType);
		return `remote-image-${Date.now()}${extension ? `.${extension}` : ''}`;
	}

	mimeTypeToExtension(mimeType: string): string {
		switch (mimeType.toLowerCase()) {
			case 'image/png': return 'png';
			case 'image/jpeg': return 'jpg';
			case 'image/gif': return 'gif';
			case 'image/bmp': return 'bmp';
			case 'image/svg+xml': return 'svg';
			case 'image/webp': return 'webp';
			default: return '';
		}
	}

	normalizeFilePatterns(patterns: string[] | string | undefined): string[] {
		return normalizeFilePatterns(patterns);
	}

	findMatchingPattern(fileName: string): string | null {
		for (const pattern of this.getSettings().attachmentSync.filePatterns) {
			if (this.matchesFilePattern(fileName, pattern)) return pattern;
		}
		return null;
	}

	matchesFilePattern(fileName: string, pattern: string): boolean {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
		return new RegExp(`^${escaped}$`, 'i').test(fileName);
	}

	getAttachmentProject(activeFile: TFile): string {
		const frontmatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
		return readFrontmatterValue(frontmatter, this.getSettings().attachmentSync.projectFieldName) || this.getSettings().attachmentSync.defaultProject;
	}

	renderObjectKey(activeFile: TFile, fileName: string): string {
		const now = new Date();
		const project = this.getAttachmentProject(activeFile);
		const rendered = this.getSettings().attachmentSync.pathPrefixTemplate
			.split('{project}').join(project)
			.split('{yyyy}').join(String(now.getFullYear()))
			.split('{MM}').join(String(now.getMonth() + 1).padStart(2, '0'))
			.split('{dd}').join(String(now.getDate()).padStart(2, '0'))
			.split('{filename}').join(fileName);
		return this.normalizeObjectKey(rendered);
	}

	normalizeObjectKey(key: string): string {
		return key.replace(/\\/g, '/').replace(/\/+/g, '/').split('/').map((segment) => segment.trim()).filter(Boolean).join('/');
	}

	stripFrontmatter(content: string, frontmatterRegex: RegExp): string {
		return content.replace(frontmatterRegex, '');
	}
}
