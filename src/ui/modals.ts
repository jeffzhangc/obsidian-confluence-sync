import { App, Modal, Setting } from 'obsidian';

export class CreateNewConnectionModal extends Modal {
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
			.setName('Confluence page ID or URL')
			.setDesc('Enter an existing Confluence page ID or full page URL to bind this note.')
			.addText((text) =>
				text.setPlaceholder('123456 or https://wiki.example.com/pages/viewpage.action?pageId=123456').onChange((value) => {
					this.result = value;
				})
			);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('Submit').setCta().onClick(() => {
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

export class SyncDebugInfoModal extends Modal {
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
			btn.setButtonText('Close').setCta().onClick(() => {
				this.close();
			})
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
