import * as http from 'http';
import * as https from 'https';

export function buildMultipartBody(filename: string, mimeType: string, binaryContents: ArrayBuffer): { body: Buffer; boundary: string } {
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

export async function sendBinaryRequest(
	params: { url: string; method: string; headers: Record<string, string>; body: Buffer },
	action: string,
	formatError: (error: unknown, requestUrlValue?: string) => string
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
			reject(new Error(`${action} failed. ${formatError(error, params.url)}`));
		});

		request.write(params.body);
		request.end();
	});
}
