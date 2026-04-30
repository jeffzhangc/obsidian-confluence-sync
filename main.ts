import { Notice, Plugin, TFile } from 'obsidian';
import { AttachmentSyncService, normalizeFilePatterns } from './src/attachments';
import { FRONTMATTER_REGEX } from './src/constants';
import { ConfluenceService } from './src/confluence';
import { getOrMigratePageBinding, normalizeFrontmatterFieldName } from './src/frontmatter';
import { DEFAULT_ATTACHMENT_SYNC_SETTINGS, DEFAULT_SETTINGS, ObsidianConfluenceSyncSettings } from './src/settings';
import { S3Service } from './src/s3';
import { ObsidianConfluenceSyncSettingTab } from './src/ui/settings-tab';
import { CreateNewConnectionModal, SyncDebugInfoModal } from './src/ui/modals';
import { formatConfluenceError } from './src/utils/debug';

export default class ObsidianConfluenceSync extends Plugin {
	settings: ObsidianConfluenceSyncSettings;
	lastSyncDebugInfo: string;
	confluenceService: ConfluenceService;
	s3Service: S3Service;
	attachmentSyncService: AttachmentSyncService;

	async onload() {
		await this.loadSettings();
		this.lastSyncDebugInfo = 'No sync has been run yet.';
		this.confluenceService = new ConfluenceService(this.app, () => this.settings, (lines) => this.appendLastSyncDebugInfo(lines), formatConfluenceError);
		this.s3Service = new S3Service(this.app, () => this.settings, (lines) => this.appendLastSyncDebugInfo(lines), formatConfluenceError);
		this.attachmentSyncService = new AttachmentSyncService(this.app, () => this.settings, (lines) => this.appendLastSyncDebugInfo(lines), formatConfluenceError, this.confluenceService, this.s3Service);

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
					const pageId = this.confluenceService.extractConfluencePageId(result);
					if (!pageId) {
						new Notice('Enter a valid Confluence page ID or URL.');
						return;
					}
					const wikiUrl = this.confluenceService.extractConfluencePageUrl(result, pageId);
					await this.confluenceService.updateNoteProperties(activeFile, { id: pageId, wikiUrl }, this.settings);
					new Notice('Confluence page connection saved.');
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
			id: 'sync-attachments-of-current-page',
			name: 'Sync attachments of current page',
			callback: async () => {
				await this.syncAttachmentsOfActiveFile();
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

	onunload() {}

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = {
			...DEFAULT_SETTINGS,
			...loaded,
			attachmentSync: {
				...DEFAULT_ATTACHMENT_SYNC_SETTINGS,
				...(loaded?.attachmentSync ?? {}),
				s3: {
					...DEFAULT_ATTACHMENT_SYNC_SETTINGS.s3,
					...(loaded?.attachmentSync?.s3 ?? {})
				}
			}
		};
		this.settings.pageIdFieldName = normalizeFrontmatterFieldName(this.settings.pageIdFieldName, DEFAULT_SETTINGS.pageIdFieldName);
		this.settings.wikiFieldName = normalizeFrontmatterFieldName(this.settings.wikiFieldName, DEFAULT_SETTINGS.wikiFieldName);
		this.settings.attachmentSync.projectFieldName = normalizeFrontmatterFieldName(this.settings.attachmentSync.projectFieldName, DEFAULT_ATTACHMENT_SYNC_SETTINGS.projectFieldName);
		this.settings.attachmentSync.defaultProject = this.settings.attachmentSync.defaultProject.trim() || DEFAULT_ATTACHMENT_SYNC_SETTINGS.defaultProject;
		this.settings.attachmentSync.pathPrefixTemplate = this.settings.attachmentSync.pathPrefixTemplate.trim() || DEFAULT_ATTACHMENT_SYNC_SETTINGS.pathPrefixTemplate;
		this.settings.attachmentSync.filePatterns = this.normalizeFilePatterns(this.settings.attachmentSync.filePatterns);
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
			const pageBinding = await getOrMigratePageBinding(activeFile, {
				app: this.app,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
				buildConfluencePageUrl: (pageId) => this.confluenceService.buildConfluencePageUrl(pageId)
			});
			const boundPageId = pageBinding?.pageId?.trim() ?? '';
			this.setLastSyncDebugInfo([
				'Status: starting',
				`File: ${activeFile.path}`,
				`Title: ${activeFile.basename}`,
				`Configured host: ${this.settings.confluenceHost || '(empty)'}`,
				`Configured parentPageId: ${this.settings.parentPageId || '(empty)'}`,
				`Page ID field: ${this.settings.pageIdFieldName}`,
				`Wiki field: ${this.settings.wikiFieldName}`,
				`Attachment mode: ${this.settings.attachmentSync.mode}`,
				`Mapped pageId: ${boundPageId || '(empty)'}`,
				`Auth mode: ${this.confluenceService.getAuthMode()}`
			]);
			const page = await this.confluenceService.ensureConfluencePage(boundPageId, activeFile.basename);
			const rawContent = await this.app.vault.read(activeFile);
			const attachmentRun = await this.attachmentSyncService.runAttachmentSync(activeFile, rawContent, page.id, true);
			const sanitizedContent = this.stripFrontmatter(attachmentRun.confluenceContent);
			new Notice('Syncing to Confluence...');
			const syncedPage = await this.confluenceService.syncContentsToConfluence(page.id, sanitizedContent, activeFile.basename);
			await this.confluenceService.updateNoteProperties(activeFile, syncedPage, this.settings);
			this.setLastSyncDebugInfo([
				'Status: success',
				`File: ${activeFile.path}`,
				`Resolved pageId: ${page.id}`,
				`Synced pageId: ${syncedPage.id}`,
				`Uploaded attachments: ${attachmentRun.uploadedCount}`,
				`Skipped attachments: ${attachmentRun.skippedCount}`,
				`Rewritten attachments: ${attachmentRun.rewrittenCount}`,
				`Deleted local attachments: ${attachmentRun.deletedCount}`,
				`Confluence URL: ${this.confluenceService.getConfluencePageUrl(syncedPage)}`
			]);
			new Notice('Sync completed.');
		} catch (error) {
			const message = formatConfluenceError(error);
			this.appendLastSyncDebugInfo(['Status: failed', `Error: ${message}`]);
			new Notice(`Confluence sync failed: ${message}`);
			console.error(error);
		}
	}

	async syncAttachmentsOfActiveFile(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file found.');
			return;
		}

		try {
			const pageBinding = await getOrMigratePageBinding(activeFile, {
				app: this.app,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
				buildConfluencePageUrl: (pageId) => this.confluenceService.buildConfluencePageUrl(pageId)
			});
			const boundPageId = pageBinding?.pageId?.trim() ?? '';
			this.setLastSyncDebugInfo([
				'Status: starting attachment sync',
				`File: ${activeFile.path}`,
				`Title: ${activeFile.basename}`,
				`Attachment mode: ${this.settings.attachmentSync.mode}`,
				`Mapped pageId: ${boundPageId || '(empty)'}`
			]);
			const rawContent = await this.app.vault.read(activeFile);
			const attachmentRun = await this.attachmentSyncService.runAttachmentSync(activeFile, rawContent, boundPageId || undefined, true);
			this.setLastSyncDebugInfo([
				'Status: attachment sync success',
				`File: ${activeFile.path}`,
				`Uploaded attachments: ${attachmentRun.uploadedCount}`,
				`Skipped attachments: ${attachmentRun.skippedCount}`,
				`Rewritten attachments: ${attachmentRun.rewrittenCount}`,
				`Deleted local attachments: ${attachmentRun.deletedCount}`
			]);
			new Notice('Attachment sync completed.');
		} catch (error) {
			const message = formatConfluenceError(error);
			this.appendLastSyncDebugInfo(['Status: attachment sync failed', `Error: ${message}`]);
			new Notice(`Attachment sync failed: ${message}`);
			console.error(error);
		}
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

	normalizeFrontmatterFieldName(fieldName: string | undefined, fallback: string): string {
		return normalizeFrontmatterFieldName(fieldName, fallback);
	}

	normalizeFilePatterns(patterns: string[] | string | undefined): string[] {
		return normalizeFilePatterns(patterns);
	}

	stripFrontmatter(content: string): string {
		return content.replace(FRONTMATTER_REGEX, '');
	}
}
