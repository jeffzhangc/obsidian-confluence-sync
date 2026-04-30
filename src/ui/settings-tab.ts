import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { AttachmentSyncMode, DEFAULT_ATTACHMENT_SYNC_SETTINGS, DEFAULT_SETTINGS, ObsidianConfluenceSyncSettings } from '../settings';

export interface SettingsTabPluginBridge extends Plugin {
	settings: ObsidianConfluenceSyncSettings;
	saveSettings(): Promise<void>;
	normalizeFrontmatterFieldName(fieldName: string | undefined, fallback: string): string;
	normalizeFilePatterns(patterns: string[] | string | undefined): string[];
}

export class ObsidianConfluenceSyncSettingTab extends PluginSettingTab {
	plugin: SettingsTabPluginBridge;

	constructor(app: App, plugin: SettingsTabPluginBridge) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Confluence Host')
			.setDesc('Host URL for Confluence, for example http://wiki.yuntongxun.com')
			.addText((text) => text.setPlaceholder('http://wiki.yuntongxun.com').setValue(this.plugin.settings.confluenceHost).onChange(async (value) => {
				this.plugin.settings.confluenceHost = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Username')
			.setDesc('Confluence username for Basic authentication')
			.addText((text) => text.setPlaceholder('zhanghl1').setValue(this.plugin.settings.username).onChange(async (value) => {
				this.plugin.settings.username = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Password')
			.setDesc('Confluence password for Basic authentication')
			.addText((text) => text.setPlaceholder('Password').setValue(this.plugin.settings.password).onChange(async (value) => {
				this.plugin.settings.password = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Parent Page ID')
			.setDesc('Parent Confluence page ID. New notes are created under this page and then bound for future syncs.')
			.addText((text) => text.setPlaceholder('123456').setValue(this.plugin.settings.parentPageId).onChange(async (value) => {
				this.plugin.settings.parentPageId = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Confluence page ID field')
			.setDesc('Frontmatter field used to store the Confluence page ID.')
			.addText((text) => text.setPlaceholder('confluencePageId').setValue(this.plugin.settings.pageIdFieldName).onChange(async (value) => {
				const normalized = this.plugin.normalizeFrontmatterFieldName(value, DEFAULT_SETTINGS.pageIdFieldName);
				if (normalized === this.plugin.settings.wikiFieldName) {
					new Notice('Page ID field and wiki field must be different.');
					return;
				}
				this.plugin.settings.pageIdFieldName = normalized;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Wiki field')
			.setDesc('Frontmatter field used to store the Confluence page URL.')
			.addText((text) => text.setPlaceholder('wiki').setValue(this.plugin.settings.wikiFieldName).onChange(async (value) => {
				const normalized = this.plugin.normalizeFrontmatterFieldName(value, DEFAULT_SETTINGS.wikiFieldName);
				if (normalized === this.plugin.settings.pageIdFieldName) {
					new Notice('Page ID field and wiki field must be different.');
					return;
				}
				this.plugin.settings.wikiFieldName = normalized;
				await this.plugin.saveSettings();
			}));

		containerEl.createEl('h2', { text: 'Attachment Sync' });

		new Setting(containerEl)
			.setName('Attachment mode')
			.setDesc('Default keeps wiki sync. In s3 mode, only files matching the patterns are uploaded to S3 and rewritten locally.')
			.addDropdown((dropdown) => dropdown.addOption('wiki', 'wiki').addOption('s3', 's3').setValue(this.plugin.settings.attachmentSync.mode).onChange(async (value: AttachmentSyncMode) => {
				this.plugin.settings.attachmentSync.mode = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Attachment file patterns')
			.setDesc('Filename-only patterns for S3 upload. Supports * wildcard, separated by commas or new lines.')
			.addTextArea((text) => text.setPlaceholder('*.log\n*.log.gz\n*.tgz').setValue(this.plugin.settings.attachmentSync.filePatterns.join('\n')).onChange(async (value) => {
				this.plugin.settings.attachmentSync.filePatterns = this.plugin.normalizeFilePatterns(value);
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Path template')
			.setDesc('Supports {project}, {yyyy}, {MM}, {dd}, {filename}.')
			.addText((text) => text.setPlaceholder('{project}/{yyyy}/{MM}/{dd}/{filename}').setValue(this.plugin.settings.attachmentSync.pathPrefixTemplate).onChange(async (value) => {
				this.plugin.settings.attachmentSync.pathPrefixTemplate = value.trim() || DEFAULT_ATTACHMENT_SYNC_SETTINGS.pathPrefixTemplate;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Project field name')
			.setDesc('Frontmatter field used for {project}.')
			.addText((text) => text.setPlaceholder('project').setValue(this.plugin.settings.attachmentSync.projectFieldName).onChange(async (value) => {
				this.plugin.settings.attachmentSync.projectFieldName = this.plugin.normalizeFrontmatterFieldName(value, DEFAULT_ATTACHMENT_SYNC_SETTINGS.projectFieldName);
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Default project')
			.setDesc('Fallback value when the project frontmatter is missing.')
			.addText((text) => text.setPlaceholder('default').setValue(this.plugin.settings.attachmentSync.defaultProject).onChange(async (value) => {
				this.plugin.settings.attachmentSync.defaultProject = value.trim() || DEFAULT_ATTACHMENT_SYNC_SETTINGS.defaultProject;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Replace links when S3 upload succeeds')
			.setDesc('Rewrites matching attachment links to the uploaded S3-compatible URL.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.attachmentSync.replaceLinksWhenS3).onChange(async (value) => {
				if (!value && this.plugin.settings.attachmentSync.deleteLocalAfterUpload) {
					new Notice('Disable local deletion before turning off S3 link replacement.');
					return;
				}
				this.plugin.settings.attachmentSync.replaceLinksWhenS3 = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Delete local files after upload')
			.setDesc('Deletes local attachments only after upload succeeds, links are rewritten, and the note is saved.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.attachmentSync.deleteLocalAfterUpload).onChange(async (value) => {
				if (value && !this.plugin.settings.attachmentSync.replaceLinksWhenS3) {
					new Notice('Enable S3 link replacement before deleting local attachments.');
					return;
				}
				this.plugin.settings.attachmentSync.deleteLocalAfterUpload = value;
				await this.plugin.saveSettings();
			}));

		containerEl.createEl('h3', { text: 'S3-compatible storage' });

		new Setting(containerEl)
			.setName('S3 endpoint')
			.setDesc('S3-compatible endpoint, for example https://minio.example.com.')
			.addText((text) => text.setPlaceholder('https://minio.example.com').setValue(this.plugin.settings.attachmentSync.s3.endpoint).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.endpoint = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('S3 region')
			.setDesc('Region used for signing. Defaults to us-east-1.')
			.addText((text) => text.setPlaceholder('us-east-1').setValue(this.plugin.settings.attachmentSync.s3.region).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.region = value.trim() || DEFAULT_ATTACHMENT_SYNC_SETTINGS.s3.region;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('S3 bucket')
			.setDesc('Bucket used for attachment uploads.')
			.addText((text) => text.setPlaceholder('obsidian-attachments').setValue(this.plugin.settings.attachmentSync.s3.bucket).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.bucket = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('S3 access key')
			.setDesc('Access key id for S3-compatible uploads.')
			.addText((text) => text.setPlaceholder('access-key').setValue(this.plugin.settings.attachmentSync.s3.accessKeyId).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.accessKeyId = value.trim();
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('S3 secret key')
			.setDesc('Secret key for S3-compatible uploads.')
			.addText((text) => text.setPlaceholder('secret-key').setValue(this.plugin.settings.attachmentSync.s3.secretAccessKey).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.secretAccessKey = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Force path style')
			.setDesc('Enable for MinIO, RustFS, and other path-style compatible endpoints.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.attachmentSync.s3.forcePathStyle).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.forcePathStyle = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Public base URL')
			.setDesc('Optional public URL prefix used when rewriting note links after S3 upload.')
			.addText((text) => text.setPlaceholder('https://files.example.com/obsidian-attachments').setValue(this.plugin.settings.attachmentSync.s3.publicBaseUrl).onChange(async (value) => {
				this.plugin.settings.attachmentSync.s3.publicBaseUrl = value.trim();
				await this.plugin.saveSettings();
			}));
	}
}
