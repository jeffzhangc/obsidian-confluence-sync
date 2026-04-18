import * as http from 'http';
import * as https from 'https';
import { App, Modal, Notice, Plugin, PluginSettingTab, RequestUrlParam, RequestUrlResponse, Setting, TFile, requestUrl } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';

interface ObsidianConfluenceSyncSettings {
	confluenceHost: string;
	personalAccessToken: string;
	username: string;
	password: string;
	parentPageId: string;
	mapping: { [key: string]: string };
}

interface ConfluencePage {
	id: string;
	type: string;
	title: string;
	version?: {
		number: number;
	};
	space?: {
		key: string;
	};
	_links?: {
		base?: string;
		download?: string;
		webui?: string;
	};
}

interface ConfluenceAttachment {
	id: string;
	title: string;
	version?: {
		number: number;
	};
	_links?: {
		download?: string;
		base?: string;
	};
}

const DEFAULT_SETTINGS: ObsidianConfluenceSyncSettings = {
	confluenceHost: '',
	personalAccessToken: '',
	username: '',
	password: '',
	parentPageId: '',
	mapping: {}
};

const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp']);

export default class ObsidianConfluenceSync extends Plugin {
	settings: ObsidianConfluenceSyncSettings;
	lastSyncDebugInfo: string;

	async onload() {
		await this.loadSettings();
		this.lastSyncDebugInfo = 'No sync has been run yet.';

		this.addCommand({
			id: 'sync-to-confluence',
			name: 'Sync contents of current page to Confluence',
			callback: async () => {
				await this.syncActiveFile();
			}
		});

		this.addCommand({
			id: 'create-confluence-connection',
			name: 'Create new Confluence connection',
			callback: async () => {
				new CreateNewConnectionModal(this.app, async (result) => {
					const activeFile = this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice('No active file found.');
						return;
					}

					const uniqueId = await this.createOrGetUniqueId(activeFile);
					this.settings.mapping[uniqueId] = result.trim();
					await this.saveSettings();
					new Notice('Confluence page mapping saved.');
				}).open();
			}
		});

		this.addCommand({
			id: 'show-last-confluence-sync-debug-info',
			name: 'Show last Confluence sync debug info',
			callback: async () => {
				new SyncDebugInfoModal(this.app, this.lastSyncDebugInfo).open();
			}
		});

		this.addCommand({
			id: 'copy-last-confluence-sync-debug-info',
			name: 'Copy last Confluence sync debug info',
			callback: async () => {
				await this.copyLastSyncDebugInfo();
			}
		});

		this.addSettingTab(new ObsidianConfluenceSyncSettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async syncActiveFile(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file found.');
			return;
		}

		try {
			const uniqueId = await this.createOrGetUniqueId(activeFile);
			this.setLastSyncDebugInfo([
				'Status: starting',
				`File: ${activeFile.path}`,
				`Title: ${activeFile.basename}`,
				`Unique ID: ${uniqueId}`,
				`Configured host: ${this.settings.confluenceHost || '(empty)'}`,
				`Configured parentPageId: ${this.settings.parentPageId || '(empty)'}`,
				`Mapped pageId: ${this.settings.mapping[uniqueId] || '(empty)'}`,
				`Auth mode: ${this.getAuthMode()}`
			]);
			const page = await this.ensureConfluencePage(uniqueId, activeFile.basename);
			const rawContent = await this.app.vault.read(activeFile);
			const sanitizedContent = this.stripFrontmatter(rawContent);
			const attachmentUpload = await this.uploadAttachmentsAndRewriteContent(activeFile, sanitizedContent, page.id);

			new Notice('Syncing to Confluence...');
			const syncedPage = await this.syncContentsToConfluence(page.id, attachmentUpload.content, activeFile.basename);

			this.settings.mapping[uniqueId] = syncedPage.id;
			await this.saveSettings();
			await this.updateNoteProperties(activeFile, syncedPage);
			this.setLastSyncDebugInfo([
				'Status: success',
				`File: ${activeFile.path}`,
				`Unique ID: ${uniqueId}`,
				`Resolved pageId: ${page.id}`,
				`Synced pageId: ${syncedPage.id}`,
				`Uploaded attachments: ${attachmentUpload.uploadedCount}`,
				`Skipped attachments: ${attachmentUpload.skippedCount}`,
				`Confluence URL: ${this.getConfluencePageUrl(syncedPage)}`
			]);

			new Notice('Sync completed.');
		} catch (error) {
			const message = this.formatConfluenceError(error);
			this.appendLastSyncDebugInfo([
				'Status: failed',
				`Error: ${message}`
			]);
			new Notice(`Confluence sync failed: ${message}`);
			console.error(error);
		}
	}

	getAuthMode(): string {
		if (this.settings.username && this.settings.password) {
			return 'basic';
		}

		if (this.settings.personalAccessToken) {
			return 'bearer';
		}

		return 'none';
	}

	getConfluenceHost(): string {
		return this.settings.confluenceHost.replace(/\/+$/, '');
	}

	getAuthorizationHeader(): string {
		if (this.settings.username && this.settings.password) {
			const credentials = Buffer.from(`${this.settings.username}:${this.settings.password}`).toString('base64');
			return `Basic ${credentials}`;
		}

		if (this.settings.personalAccessToken) {
			return `Bearer ${this.settings.personalAccessToken}`;
		}

		throw new Error('Missing Confluence authentication settings.');
	}

	getConfluenceHeaders(contentType?: string, extraHeaders: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: this.getAuthorizationHeader(),
			...extraHeaders
		};

		if (contentType) {
			headers['Content-Type'] = contentType;
		}

		return headers;
	}

	async requestConfluence(params: RequestUrlParam, action: string): Promise<RequestUrlResponse> {
		this.appendLastSyncDebugInfo([
			`Request: ${action}`,
			`Method: ${params.method ?? 'GET'}`,
			`URL: ${params.url}`
		]);

		try {
			const response = await requestUrl(params);

			if (response.status >= 400) {
				const responseText = typeof response.text === 'string' ? response.text.trim() : '';
				const detail = responseText ? ` Response: ${responseText.slice(0, 300)}` : '';
				throw new Error(`${action} failed. HTTP ${response.status}. URL: ${params.url}.${detail}`);
			}

			return response;
		} catch (error) {
			if (this.shouldRetryWithHttps(params)) {
				const httpsParams = {
					...params,
					url: this.toHttpsUrl(params.url)
				};

				try {
					return await requestUrl(httpsParams);
				} catch (httpsError) {
					throw new Error(`${action} failed. ${this.formatConfluenceError(httpsError, httpsParams.url)}`);
				}
			}

			throw new Error(`${action} failed. ${this.formatConfluenceError(error, params.url)}`);
		}
	}

	shouldRetryWithHttps(params: RequestUrlParam): boolean {
		return params.url.startsWith('http://');
	}

	toHttpsUrl(url: string): string {
		return url.replace(/^http:\/\//i, 'https://');
	}

	formatConfluenceError(error: unknown, requestUrlValue?: string): string {
		if (error instanceof Error) {
			const errorWithFields = error as Error & {
				status?: number;
				url?: string;
				text?: string;
				response?: {
					status?: number;
					url?: string;
					text?: string;
				};
			};
			const status = errorWithFields.status ?? errorWithFields.response?.status;
			const errorUrl = errorWithFields.url ?? errorWithFields.response?.url ?? requestUrlValue;
			const responseText = errorWithFields.text ?? errorWithFields.response?.text;
			const detail = responseText ? ` Response: ${responseText.slice(0, 300)}` : '';
			const statusPart = status ? `HTTP ${status}. ` : '';
			const urlPart = errorUrl ? `URL: ${errorUrl}. ` : '';

			return `${statusPart}${urlPart}${error.message}${detail}`.trim();
		}

		if (typeof error === 'object' && error !== null) {
			try {
				return JSON.stringify(error);
			} catch (_jsonError) {
				return 'Unknown object error';
			}
		}

		return String(error);
	}

	setLastSyncDebugInfo(lines: string[]): void {
		this.lastSyncDebugInfo = lines.join('\n');
	}

	appendLastSyncDebugInfo(lines: string[]): void {
		this.lastSyncDebugInfo = `${this.lastSyncDebugInfo}\n${lines.join('\n')}`.trim();
	}

	async copyLastSyncDebugInfo(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.lastSyncDebugInfo);
			new Notice('Last Confluence sync debug info copied.');
		} catch (_error) {
			new SyncDebugInfoModal(this.app, this.lastSyncDebugInfo).open();
			new Notice('Clipboard copy failed. Opened debug info dialog instead.');
		}
	}

	createOrGetUniqueId = async (activeFile: TFile): Promise<string> => {
		let uniqueId = '';
		const frontmatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;

		if (frontmatter && frontmatter.uniqueId) {
			uniqueId = frontmatter.uniqueId;
		} else {
			uniqueId = this.generateUniqueID();
			await this.app.fileManager.processFrontMatter(activeFile, (fileFrontmatter) => {
				fileFrontmatter.uniqueId = uniqueId;
			});
		}

		return uniqueId;
	}

	async ensureConfluencePage(uniqueId: string, title: string): Promise<ConfluencePage> {
		const mappedPageId = this.settings.mapping[uniqueId]?.trim();
		if (mappedPageId) {
			return this.getContentFromConfluence(mappedPageId);
		}

		const parentPageId = this.settings.parentPageId.trim();
		if (!parentPageId) {
			throw new Error('No mapped page found and no parent page ID configured.');
		}

		return this.createChildPage(title, parentPageId);
	}

	async createChildPage(title: string, parentPageId: string): Promise<ConfluencePage> {
		const parentPage = await this.getContentFromConfluence(parentPageId, 'space');
		const spaceKey = parentPage.space?.key;

		if (!spaceKey) {
			throw new Error('Unable to determine Confluence space from parent page.');
		}

		const createForm = await this.loadCreatePageForm(spaceKey, parentPageId);
		await this.submitCreatePageForm(spaceKey, parentPageId, title, createForm);

		return this.getContentByTitle(spaceKey, title);
	}

	async syncContentsToConfluence(confluencePageId: string, activeFileData: string, title: string): Promise<ConfluencePage> {
		const pageContent = await this.getContentFromConfluence(confluencePageId);
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/rest/api/content/${confluencePageId}`,
			method: 'PUT',
			headers: this.getConfluenceHeaders('application/json;charset=utf-8', {
				'X-Atlassian-Token': 'no-check'
			}),
			body: JSON.stringify({
				version: {
					number: (pageContent.version?.number ?? 0) + 1
				},
				type: pageContent.type,
				title,
				body: {
					storage: {
						value: this.createPageBody(activeFileData),
						representation: 'storage'
					}
				}
			})
		}, `Update Confluence page ${confluencePageId}`);

		return response.json as ConfluencePage;
	}

	async getContentFromConfluence(confluencePageId: string, expand = 'version,space'): Promise<ConfluencePage> {
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/rest/api/content/${confluencePageId}?expand=${encodeURIComponent(expand)}`,
			method: 'GET',
			headers: this.getConfluenceHeaders()
		}, `Load Confluence page ${confluencePageId}`);

		return response.json as ConfluencePage;
	}

	async loadCreatePageForm(spaceKey: string, parentPageId: string): Promise<{
		atlToken: string;
		draftId: string;
		entityId: string;
		parentPageString: string;
		cookie: string;
	}> {
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/pages/createpage.action?spaceKey=${encodeURIComponent(spaceKey)}&fromPageId=${encodeURIComponent(parentPageId)}`,
			method: 'GET',
			headers: {
				Authorization: this.getAuthorizationHeader()
			}
		}, `Load create page form for parent ${parentPageId}`);
		const html = response.text;

		return {
			atlToken: this.extractRequiredValue(html, /meta id="atlassian-token" name="atlassian-token" content="([^"]+)"/, 'atlassian token'),
			draftId: this.extractRequiredValue(html, /meta name="ajs-draft-id" content="([^"]+)"/, 'draft id'),
			entityId: this.extractRequiredValue(html, /meta name="ajs-content-id" content="([^"]+)"/, 'entity id'),
			parentPageString: this.extractRequiredValue(html, /input id="parentPageString"[^>]*value="([^"]*)"/, 'parent page string'),
			cookie: this.extractSessionCookie(response)
		};
	}

	async submitCreatePageForm(
		spaceKey: string,
		parentPageId: string,
		title: string,
		createForm: {
			atlToken: string;
			draftId: string;
			entityId: string;
			parentPageString: string;
			cookie: string;
		}
	): Promise<void> {
		const form = new URLSearchParams({
			atl_token: createForm.atlToken,
			queryString: `spaceKey=${spaceKey}&fromPageId=${parentPageId}&src=quick-create`,
			fromPageId: parentPageId,
			spaceKey,
			labelsString: '',
			titleWritten: 'false',
			linkCreation: 'false',
			originalReferrer: `${this.getConfluenceHost()}/pages/createpage.action?spaceKey=${encodeURIComponent(spaceKey)}&fromPageId=${encodeURIComponent(parentPageId)}`,
			title,
			wysiwygContent: '<p>&nbsp;</p>',
			parentPageString: createForm.parentPageString,
			moveHierarchy: 'true',
			position: '',
			targetId: '',
			draftId: createForm.draftId,
			entityId: createForm.entityId,
			newSpaceKey: spaceKey,
			draftShareId: '',
			syncRev: ''
		});

		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/pages/docreatepage.action`,
			method: 'POST',
			headers: {
				Authorization: this.getAuthorizationHeader(),
				'Content-Type': 'application/x-www-form-urlencoded',
				Cookie: createForm.cookie
			},
			body: form.toString()
		}, `Create Confluence page under parent ${parentPageId}`);

		if (response.status !== 200 && response.status !== 302) {
			throw new Error(`Unexpected create page response status ${response.status}.`);
		}
	}

	async getContentByTitle(spaceKey: string, title: string): Promise<ConfluencePage> {
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(spaceKey)}&expand=version,space`,
			method: 'GET',
			headers: this.getConfluenceHeaders()
		}, `Find Confluence page by title ${title}`);

		const results = (response.json as { results?: ConfluencePage[] }).results ?? [];
		const page = results[0];

		if (!page) {
			throw new Error(`Created page "${title}" could not be found in space ${spaceKey}.`);
		}

		return page;
	}

	extractRequiredValue(text: string, pattern: RegExp, fieldName: string): string {
		const match = text.match(pattern);
		const value = match?.[1];

		if (!value) {
			throw new Error(`Unable to extract ${fieldName} from Confluence create page form.`);
		}

		return value;
	}

	extractSessionCookie(response: RequestUrlResponse): string {
		const responseWithHeaders = response as RequestUrlResponse & {
			headers?: Record<string, string | string[]>;
		};
		const rawSetCookie = responseWithHeaders.headers?.['set-cookie'] ?? responseWithHeaders.headers?.['Set-Cookie'];
		const firstSetCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;

		if (!firstSetCookie) {
			throw new Error('Confluence create page form did not return a session cookie.');
		}

		return firstSetCookie.split(';')[0];
	}

	stripFrontmatter(content: string): string {
		return content.replace(FRONTMATTER_REGEX, '');
	}

	createPageBody(markdown: string): string {
		const safeMarkdown = markdown.replace(/]]>/g, ']]]]><![CDATA[>');
		return `<ac:structured-macro ac:name="markdown" ac:schema-version="1"><ac:plain-text-body><![CDATA[${safeMarkdown}]]></ac:plain-text-body></ac:structured-macro>`;
	}

	async uploadAttachmentsAndRewriteContent(
		activeFile: TFile,
		content: string,
		pageId: string
	): Promise<{ content: string; uploadedCount: number; skippedCount: number }> {
		let rewrittenContent = content;
		let uploadedCount = 0;
		let skippedCount = 0;
		const wikiAttachmentMatches = Array.from(rewrittenContent.matchAll(/!\[\[([^\]]+)\]\]/g));

		// 获取 Confluence 页面上现有的附件列表
		const existingAttachments = await this.getExistingAttachments(pageId);

		for (const match of wikiAttachmentMatches) {
			const fullMatch = match[0];
			const rawTarget = match[1];
			const segments = rawTarget.split('|').map((item) => item.trim());
			const attachmentPath = segments[0];
			const altText = segments.slice(1).join(' ') || attachmentPath;
			const file = this.resolveFile(activeFile, attachmentPath);

			if (!file) {
				continue;
			}

			try {
				const attachmentUrl = await this.uploadAttachmentAndGetUrl(pageId, file, existingAttachments);
				// 图片使用 ![]() 格式，其他附件使用 []() 格式
				if (this.isImageFile(file)) {
					rewrittenContent = rewrittenContent.replace(fullMatch, `![${altText}](${attachmentUrl})`);
				} else {
					rewrittenContent = rewrittenContent.replace(fullMatch, `[${altText}](${attachmentUrl})`);
				}
				uploadedCount += 1;
			} catch (error) {
				skippedCount += 1;
				this.appendLastSyncDebugInfo([
					`Attachment upload skipped: ${file.name}`,
					`Attachment error: ${this.formatConfluenceError(error)}`
				]);
			}
		}

		return {
			content: rewrittenContent,
			uploadedCount,
			skippedCount
		};
	}

	resolveFile(activeFile: TFile, targetPath: string): TFile | null {
		const normalizedTarget = targetPath.split('#')[0].trim();
		if (!normalizedTarget) {
			return null;
		}

		const linkedFile = this.app.metadataCache.getFirstLinkpathDest(normalizedTarget, activeFile.path);
		if (linkedFile instanceof TFile) {
			return linkedFile;
		}

		const decodedTarget = decodeURIComponent(normalizedTarget.replace(/^<|>$/g, ''));
		const directFile = this.app.vault.getAbstractFileByPath(decodedTarget);
		if (directFile instanceof TFile) {
			return directFile;
		}

		return null;
	}

	isImageFile(file: TFile): boolean {
		return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
	}

	isRemoteUrl(value: string): boolean {
		return /^https?:\/\//i.test(value);
	}

	normalizeMarkdownTarget(target: string): string {
		return target.trim().replace(/^<|>$/g, '');
	}

	async getExistingAttachments(pageId: string): Promise<Map<string, ConfluenceAttachment>> {
		const attachmentsMap = new Map<string, ConfluenceAttachment>();

		try {
			const response = await this.requestConfluence({
				url: `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment?expand=version&limit=100`,
				method: 'GET',
				headers: this.getConfluenceHeaders()
			}, `Get existing attachments for page ${pageId}`);

			const attachmentData = response.json as {
				results?: Array<{
					title: string;
					id: string;
					version?: { number: number };
					_links?: { download?: string; base?: string };
				}>;
			};

			if (attachmentData.results) {
				for (const attachment of attachmentData.results) {
					attachmentsMap.set(attachment.title, {
						id: attachment.id,
						title: attachment.title,
						version: attachment.version,
						_links: attachment._links
					});
				}
			}
		} catch (error) {
			this.appendLastSyncDebugInfo([
				`Failed to get existing attachments: ${this.formatConfluenceError(error)}`
			]);
		}

		return attachmentsMap;
	}

	async uploadAttachmentAndGetUrl(pageId: string, file: TFile, existingAttachments: Map<string, ConfluenceAttachment>): Promise<string> {
		const existingAttachment = existingAttachments.get(file.name);

		// 如果附件已存在，跳过上传（避免重复）
		if (existingAttachment) {
			this.appendLastSyncDebugInfo([
				`Attachment skipped (already exists): ${file.name} (id: ${existingAttachment.id})`
			]);
			return this.getAttachmentUrl(pageId, file.name, existingAttachment);
		}

		// 上传新文件
		return this.performUpload(pageId, file, false);
	}

	async performUpload(pageId: string, file: TFile, isUpdate: boolean): Promise<string> {
		const fileContents = await this.app.vault.adapter.readBinary(file.path);
		const mimeType = this.getMimeType(file.extension);
		const multipart = this.buildMultipartBody(file.name, mimeType, fileContents);

		// 更新附件需要使用特定的 URL
		const url = isUpdate
			? `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment/${encodeURIComponent(file.name)}/data`
			: `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment`;

		const method = isUpdate ? 'PUT' : 'POST';
		const action = isUpdate ? `Update attachment ${file.name}` : `Upload attachment ${file.name}`;

		this.appendLastSyncDebugInfo([
			`Request: ${action} to page ${pageId}`,
			'Method: ' + method,
			`URL: ${url}`
		]);

		const response = await this.sendBinaryRequest({
			url: url,
			method: method,
			headers: {
				Accept: 'application/json',
				Authorization: this.getAuthorizationHeader(),
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
				'Content-Length': String(multipart.body.length),
				'X-Atlassian-Token': 'no-check'
			},
			body: multipart.body
		}, action);

		const attachmentResponse = JSON.parse(response.text) as {
			results?: Array<{
				_links?: {
					base?: string;
					download?: string;
				};
			}>;
		};
		const downloadPath = attachmentResponse.results?.[0]?._links?.download;
		const downloadBase = attachmentResponse.results?.[0]?._links?.base ?? this.getConfluenceHost();

		if (downloadPath) {
			return `${downloadBase}${downloadPath}`;
		}

		return `${this.getConfluenceHost()}/download/attachments/${pageId}/${encodeURIComponent(file.name)}`;
	}

	getAttachmentUrl(pageId: string, filename: string, attachment: ConfluenceAttachment): string {
		const downloadPath = attachment._links?.download;
		const downloadBase = attachment._links?.base ?? this.getConfluenceHost();

		if (downloadPath) {
			return `${downloadBase}${downloadPath}`;
		}

		return `${this.getConfluenceHost()}/download/attachments/${pageId}/${encodeURIComponent(filename)}`;
	}

	buildMultipartBody(filename: string, mimeType: string, binaryContents: ArrayBuffer): { body: Buffer; boundary: string } {
		const boundary = `----obsidian-confluence-sync-${Date.now()}`;
		const header = Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
		);
		const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
		const fileBytes = Buffer.from(binaryContents);
		const body = Buffer.concat([header, fileBytes, footer]);

		return {
			body,
			boundary
		};
	}

	async sendBinaryRequest(
		params: { url: string; method: string; headers: Record<string, string>; body: Buffer },
		action: string
	): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
		const targetUrl = new URL(params.url);
		const client = targetUrl.protocol === 'https:' ? https : http;

		return await new Promise((resolve, reject) => {
			const request = client.request(
				targetUrl,
				{
					method: params.method,
					headers: params.headers
				},
				(response: http.IncomingMessage) => {
					const chunks: Buffer[] = [];

					response.on('data', (chunk: Buffer | string) => {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					});
					response.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						const status = response.statusCode ?? 0;

						if (status >= 400) {
							reject(new Error(`${action} failed. HTTP ${status}. URL: ${params.url}. Response: ${text.slice(0, 300)}`));
							return;
						}

						resolve({
							status,
							text,
							headers: response.headers
						});
					});
				}
			);

			request.on('error', (error: Error) => {
				reject(new Error(`${action} failed. ${this.formatConfluenceError(error, params.url)}`));
			});

			request.write(params.body);
			request.end();
		});
	}

	getMimeType(extension: string): string {
		switch (extension.toLowerCase()) {
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'gif':
				return 'image/gif';
			case 'bmp':
				return 'image/bmp';
			case 'svg':
				return 'image/svg+xml';
			case 'webp':
				return 'image/webp';
			default:
				return 'application/octet-stream';
		}
	}

	async updateNoteProperties(activeFile: TFile, page: ConfluencePage): Promise<void> {
		const confluenceUrl = this.getConfluencePageUrl(page);

		await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
			frontmatter.confluenceUrl = confluenceUrl;
		});
	}

	getConfluencePageUrl(page: ConfluencePage): string {
		const webUi = page._links?.webui;
		const base = page._links?.base ?? this.getConfluenceHost();

		if (webUi) {
			return `${base}${webUi}`;
		}

		return `${this.getConfluenceHost()}/pages/viewpage.action?pageId=${page.id}`;
	}

	generateUniqueID(): string {
		return uuidv4();
	}
}

class CreateNewConnectionModal extends Modal {
	result: string;
	onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.result = '';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h1', { text: 'Create new Confluence connection' });

		new Setting(contentEl)
			.setName('Confluence page ID')
			.setDesc('Enter an existing Confluence page ID to bind this note.')
			.addText((text) =>
				text.setPlaceholder('123456').onChange((value) => {
					this.result = value;
				})
			);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Submit')
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.result);
				})
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SyncDebugInfoModal extends Modal {
	debugInfo: string;

	constructor(app: App, debugInfo: string) {
		super(app);
		this.debugInfo = debugInfo;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h1', { text: 'Confluence Sync Debug Info' });

		const textArea = contentEl.createEl('textarea');
		textArea.value = this.debugInfo;
		textArea.rows = 18;
		textArea.cols = 80;
		textArea.style.width = '100%';

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Close')
				.setCta()
				.onClick(() => {
					this.close();
				})
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ObsidianConfluenceSyncSettingTab extends PluginSettingTab {
	plugin: ObsidianConfluenceSync;

	constructor(app: App, plugin: ObsidianConfluenceSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Confluence Host')
			.setDesc('Host URL for Confluence, for example http://wiki.yuntongxun.com')
			.addText((text) =>
				text.setPlaceholder('http://wiki.yuntongxun.com').setValue(this.plugin.settings.confluenceHost).onChange(async (value) => {
					this.plugin.settings.confluenceHost = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Username')
			.setDesc('Confluence username for Basic authentication')
			.addText((text) =>
				text.setPlaceholder('zhanghl1').setValue(this.plugin.settings.username).onChange(async (value) => {
					this.plugin.settings.username = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Password')
			.setDesc('Confluence password for Basic authentication')
			.addText((text) =>
				text.setPlaceholder('Password').setValue(this.plugin.settings.password).onChange(async (value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Parent Page ID')
			.setDesc('Parent Confluence page ID. New notes are created under this page and then bound for future syncs.')
			.addText((text) =>
				text.setPlaceholder('123456').setValue(this.plugin.settings.parentPageId).onChange(async (value) => {
					this.plugin.settings.parentPageId = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Personal Access Token')
			.setDesc('Optional Bearer token fallback for newer Confluence servers')
			.addText((text) =>
				text.setPlaceholder('Personal Access Token').setValue(this.plugin.settings.personalAccessToken).onChange(async (value) => {
					this.plugin.settings.personalAccessToken = value.trim();
					await this.plugin.saveSettings();
				})
			);
	}
}
