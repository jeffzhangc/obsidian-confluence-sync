import { RequestUrlParam, RequestUrlResponse, TFile, requestUrl } from 'obsidian';
import { buildMultipartBody, sendBinaryRequest } from './network';
import { extractRequiredValue, extractSessionCookie } from './frontmatter';
import { ObsidianConfluenceSyncSettings } from './settings';

export interface ConfluencePage {
	id: string;
	type: string;
	title: string;
	version?: { number: number };
	space?: { key: string };
	_links?: { base?: string; download?: string; webui?: string };
}

export interface ConfluenceAttachment {
	id: string;
	title: string;
	version?: { number: number };
	_links?: { download?: string; base?: string };
}

export class ConfluenceService {
	constructor(
		private readonly app: any,
		private readonly getSettings: () => ObsidianConfluenceSyncSettings,
		private readonly appendDebugInfo: (lines: string[]) => void,
		private readonly formatError: (error: unknown, requestUrlValue?: string) => string
	) {}

	getAuthMode(): string {
		const settings = this.getSettings();
		if (settings.username && settings.password) return 'basic';
		if (settings.personalAccessToken) return 'bearer';
		return 'none';
	}

	getConfluenceHost(): string {
		return this.getSettings().confluenceHost.replace(/\/+$/, '');
	}

	getAuthorizationHeader(): string {
		const settings = this.getSettings();
		if (settings.username && settings.password) {
			const credentials = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
			return `Basic ${credentials}`;
		}
		if (settings.personalAccessToken) return `Bearer ${settings.personalAccessToken}`;
		throw new Error('Missing Confluence authentication settings.');
	}

	getConfluenceHeaders(contentType?: string, extraHeaders: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: this.getAuthorizationHeader(),
			...extraHeaders
		};
		if (contentType) headers['Content-Type'] = contentType;
		return headers;
	}

	async requestConfluence(params: RequestUrlParam, action: string): Promise<RequestUrlResponse> {
		this.appendDebugInfo([`Request: ${action}`, `Method: ${params.method ?? 'GET'}`, `URL: ${params.url}`]);
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
				const httpsParams = { ...params, url: this.toHttpsUrl(params.url) };
				try {
					return await requestUrl(httpsParams);
				} catch (httpsError) {
					throw new Error(`${action} failed. ${this.formatError(httpsError, httpsParams.url)}`);
				}
			}
			throw new Error(`${action} failed. ${this.formatError(error, params.url)}`);
		}
	}

	shouldRetryWithHttps(params: RequestUrlParam): boolean {
		return params.url.startsWith('http://');
	}

	toHttpsUrl(url: string): string {
		return url.replace(/^http:\/\//i, 'https://');
	}

	async ensureConfluencePage(pageId: string, title: string): Promise<ConfluencePage> {
		if (pageId) return this.getContentFromConfluence(pageId);
		const parentPageId = this.getSettings().parentPageId.trim();
		if (!parentPageId) throw new Error('No bound page found and no parent page ID configured.');
		return this.createChildPage(title, parentPageId);
	}

	async createChildPage(title: string, parentPageId: string): Promise<ConfluencePage> {
		const parentPage = await this.getContentFromConfluence(parentPageId, 'space');
		const spaceKey = parentPage.space?.key;
		if (!spaceKey) throw new Error('Unable to determine Confluence space from parent page.');
		const createForm = await this.loadCreatePageForm(spaceKey, parentPageId);
		await this.submitCreatePageForm(spaceKey, parentPageId, title, createForm);
		return this.getContentByTitle(spaceKey, title);
	}

	async syncContentsToConfluence(confluencePageId: string, activeFileData: string, title: string): Promise<ConfluencePage> {
		const pageContent = await this.getContentFromConfluence(confluencePageId);
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/rest/api/content/${confluencePageId}`,
			method: 'PUT',
			headers: this.getConfluenceHeaders('application/json;charset=utf-8', { 'X-Atlassian-Token': 'no-check' }),
			body: JSON.stringify({
				version: { number: (pageContent.version?.number ?? 0) + 1 },
				type: pageContent.type,
				title,
				body: { storage: { value: this.createPageBody(activeFileData), representation: 'storage' } }
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

	async loadCreatePageForm(spaceKey: string, parentPageId: string) {
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/pages/createpage.action?spaceKey=${encodeURIComponent(spaceKey)}&fromPageId=${encodeURIComponent(parentPageId)}`,
			method: 'GET',
			headers: { Authorization: this.getAuthorizationHeader() }
		}, `Load create page form for parent ${parentPageId}`);
		const html = response.text;
		return {
			atlToken: extractRequiredValue(html, /meta id="atlassian-token" name="atlassian-token" content="([^"]+)"/, 'atlassian token'),
			draftId: extractRequiredValue(html, /meta name="ajs-draft-id" content="([^"]+)"/, 'draft id'),
			entityId: extractRequiredValue(html, /meta name="ajs-content-id" content="([^"]+)"/, 'entity id'),
			parentPageString: extractRequiredValue(html, /input id="parentPageString"[^>]*value="([^"]*)"/, 'parent page string'),
			cookie: extractSessionCookie(response)
		};
	}

	async submitCreatePageForm(spaceKey: string, parentPageId: string, title: string, createForm: any): Promise<void> {
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
			headers: { Authorization: this.getAuthorizationHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Cookie: createForm.cookie },
			body: form.toString()
		}, `Create Confluence page under parent ${parentPageId}`);
		if (response.status !== 200 && response.status !== 302) throw new Error(`Unexpected create page response status ${response.status}.`);
	}

	async getContentByTitle(spaceKey: string, title: string): Promise<ConfluencePage> {
		const response = await this.requestConfluence({
			url: `${this.getConfluenceHost()}/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(spaceKey)}&expand=version,space`,
			method: 'GET',
			headers: this.getConfluenceHeaders()
		}, `Find Confluence page by title ${title}`);
		const results = (response.json as { results?: ConfluencePage[] }).results ?? [];
		const page = results[0];
		if (!page) throw new Error(`Created page "${title}" could not be found in space ${spaceKey}.`);
		return page;
	}

	createPageBody(markdown: string): string {
		const safeMarkdown = markdown.replace(/]]>/g, ']]]]><![CDATA[>');
		return `<ac:structured-macro ac:name="markdown" ac:schema-version="1"><ac:plain-text-body><![CDATA[${safeMarkdown}]]></ac:plain-text-body></ac:structured-macro>`;
	}

	buildConfluencePageUrl(pageId: string): string {
		return `${this.getConfluenceHost()}/pages/viewpage.action?pageId=${pageId}`;
	}

	getConfluencePageUrl(page: ConfluencePage | { id: string; _links?: { base?: string; webui?: string } }): string {
		const webUi = page._links?.webui;
		const base = page._links?.base ?? this.getConfluenceHost();
		if (webUi) return `${base}${webUi}`;
		return this.buildConfluencePageUrl(page.id);
	}

	extractConfluencePageId(value: string): string {
		const trimmedValue = value.trim();
		if (!trimmedValue) return '';
		if (/^\d+$/.test(trimmedValue)) return trimmedValue;
		const urlMatch = trimmedValue.match(/[?&]pageId=(\d+)/i);
		return urlMatch ? urlMatch[1] : '';
	}

	extractConfluencePageUrl(value: string, pageId: string): string {
		const trimmedValue = value.trim();
		if (/^https?:\/\//i.test(trimmedValue)) return trimmedValue;
		return this.buildConfluencePageUrl(pageId);
	}

	async updateNoteProperties(activeFile: TFile, page: ConfluencePage | { id: string; wikiUrl?: string }, settings: ObsidianConfluenceSyncSettings): Promise<void> {
		const wikiUrl = 'wikiUrl' in page && page.wikiUrl ? page.wikiUrl : this.getConfluencePageUrl(page);
		await this.app.fileManager.processFrontMatter(activeFile, (frontmatter: Record<string, unknown>) => {
			frontmatter[settings.pageIdFieldName] = page.id;
			frontmatter[settings.wikiFieldName] = wikiUrl;
		});
	}

	async getExistingAttachments(pageId: string): Promise<Map<string, ConfluenceAttachment>> {
		const attachmentsMap = new Map<string, ConfluenceAttachment>();
		try {
			const response = await this.requestConfluence({
				url: `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment?expand=version&limit=100`,
				method: 'GET',
				headers: this.getConfluenceHeaders()
			}, `Get existing attachments for page ${pageId}`);
			const attachmentData = response.json as { results?: Array<{ title: string; id: string; version?: { number: number }; _links?: { download?: string; base?: string } }> };
			if (attachmentData.results) {
				for (const attachment of attachmentData.results) {
					attachmentsMap.set(attachment.title, { id: attachment.id, title: attachment.title, version: attachment.version, _links: attachment._links });
				}
			}
		} catch (error) {
			this.appendDebugInfo([`Failed to get existing attachments: ${this.formatError(error)}`]);
		}
		return attachmentsMap;
	}

	async uploadAttachmentAndGetUrl(pageId: string, file: TFile, existingAttachments: Map<string, ConfluenceAttachment>): Promise<string> {
		const existingAttachment = existingAttachments.get(file.name);
		if (existingAttachment) {
			this.appendDebugInfo([`Attachment skipped (already exists): ${file.name} (id: ${existingAttachment.id})`]);
			return this.getAttachmentUrl(pageId, file.name, existingAttachment);
		}
		const fileContents = await this.app.vault.adapter.readBinary(file.path);
		return this.uploadBinaryAttachmentAndGetUrl(pageId, file.name, this.getMimeType(file.extension), fileContents, existingAttachments);
	}

	async uploadBinaryAttachmentAndGetUrl(
		pageId: string,
		filename: string,
		mimeType: string,
		fileContents: ArrayBuffer,
		existingAttachments: Map<string, ConfluenceAttachment>
	): Promise<string> {
		const existingAttachment = existingAttachments.get(filename);
		if (existingAttachment) {
			this.appendDebugInfo([`Attachment skipped (already exists): ${filename} (id: ${existingAttachment.id})`]);
			return this.getAttachmentUrl(pageId, filename, existingAttachment);
		}
		const uploadResult = await this.performUpload(pageId, filename, mimeType, fileContents, false);
		existingAttachments.set(filename, uploadResult.attachment);
		return uploadResult.url;
	}

	async performUpload(pageId: string, filename: string, mimeType: string, fileContents: ArrayBuffer, isUpdate: boolean): Promise<{ url: string; attachment: ConfluenceAttachment }> {
		const multipart = buildMultipartBody(filename, mimeType, fileContents);
		const url = isUpdate ? `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment/${encodeURIComponent(filename)}/data` : `${this.getConfluenceHost()}/rest/api/content/${pageId}/child/attachment`;
		const method = isUpdate ? 'PUT' : 'POST';
		const action = isUpdate ? `Update attachment ${filename}` : `Upload attachment ${filename}`;
		this.appendDebugInfo([`Request: ${action} to page ${pageId}`, 'Method: ' + method, `URL: ${url}`]);
		const response = await sendBinaryRequest({
			url,
			method,
			headers: {
				Accept: 'application/json',
				Authorization: this.getAuthorizationHeader(),
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
				'Content-Length': String(multipart.body.length),
				'X-Atlassian-Token': 'no-check'
			},
			body: multipart.body
		}, action, this.formatError);
		const attachmentResponse = JSON.parse(response.text) as { results?: Array<{ id: string; title: string; version?: { number: number }; _links?: { base?: string; download?: string } }> };
		const result = attachmentResponse.results?.[0];
		const attachment: ConfluenceAttachment = {
			id: result?.id ?? '',
			title: result?.title ?? filename,
			version: result?.version,
			_links: result?._links
		};
		const downloadPath = result?._links?.download;
		const downloadBase = result?._links?.base ?? this.getConfluenceHost();
		return {
			url: downloadPath ? `${downloadBase}${downloadPath}` : `${this.getConfluenceHost()}/download/attachments/${pageId}/${encodeURIComponent(filename)}`,
			attachment
		};
	}

	getAttachmentUrl(pageId: string, filename: string, attachment: ConfluenceAttachment): string {
		const downloadPath = attachment._links?.download;
		const downloadBase = attachment._links?.base ?? this.getConfluenceHost();
		if (downloadPath) return `${downloadBase}${downloadPath}`;
		return `${this.getConfluenceHost()}/download/attachments/${pageId}/${encodeURIComponent(filename)}`;
	}

	getMimeType(extension: string): string {
		switch (extension.toLowerCase()) {
			case 'png': return 'image/png';
			case 'jpg':
			case 'jpeg': return 'image/jpeg';
			case 'gif': return 'image/gif';
			case 'bmp': return 'image/bmp';
			case 'svg': return 'image/svg+xml';
			case 'webp': return 'image/webp';
			default: return 'application/octet-stream';
		}
	}
}
