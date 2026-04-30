import { RequestUrlResponse, TFile } from 'obsidian';

export function normalizeFrontmatterFieldName(fieldName: string | undefined, fallback: string): string {
	const normalized = fieldName?.trim();
	return normalized || fallback;
}

export function readFrontmatterValue(frontmatter: Record<string, unknown> | undefined, fieldName: string): string {
	const value = frontmatter?.[fieldName];
	if (typeof value === 'string') {
		return value.trim();
	}

	if (typeof value === 'number') {
		return String(value);
	}

	return '';
}

export function extractRequiredValue(text: string, pattern: RegExp, fieldName: string): string {
	const match = text.match(pattern);
	const value = match?.[1];

	if (!value) {
		throw new Error(`Unable to extract ${fieldName} from Confluence create page form.`);
	}

	return value;
}

export function extractSessionCookie(response: RequestUrlResponse): string {
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

export async function getOrMigratePageBinding(
	activeFile: TFile,
	deps: {
		app: any;
		settings: any;
		saveSettings: () => Promise<void>;
		buildConfluencePageUrl: (pageId: string) => string;
	}
): Promise<{ pageId: string; wikiUrl: string } | null> {
	const frontmatter = deps.app.metadataCache.getFileCache(activeFile)?.frontmatter;
	const directPageId = readFrontmatterValue(frontmatter, deps.settings.pageIdFieldName);
	if (directPageId) {
		return {
			pageId: directPageId,
			wikiUrl: readFrontmatterValue(frontmatter, deps.settings.wikiFieldName)
		};
	}

	const legacyUniqueId = readFrontmatterValue(frontmatter, 'uniqueId');
	const legacyPageId = legacyUniqueId ? deps.settings.mapping?.[legacyUniqueId]?.trim() ?? '' : '';
	if (!legacyPageId) {
		return null;
	}

	const wikiUrl = deps.buildConfluencePageUrl(legacyPageId);
	await deps.app.fileManager.processFrontMatter(activeFile, (fileFrontmatter: Record<string, unknown>) => {
		fileFrontmatter[deps.settings.pageIdFieldName] = legacyPageId;
		fileFrontmatter[deps.settings.wikiFieldName] = wikiUrl;
		delete fileFrontmatter.uniqueId;
	});

	if (legacyUniqueId && deps.settings.mapping) {
		delete deps.settings.mapping[legacyUniqueId];
		await deps.saveSettings();
	}

	return {
		pageId: legacyPageId,
		wikiUrl
	};
}
