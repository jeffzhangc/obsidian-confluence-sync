export function formatConfluenceError(error: unknown, requestUrlValue?: string): string {
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
