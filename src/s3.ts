import * as crypto from 'crypto';
import { TFile } from 'obsidian';
import { ObsidianConfluenceSyncSettings } from './settings';
import { sendBinaryRequest } from './network';

export class S3Service {
	constructor(
		private readonly app: any,
		private readonly getSettings: () => ObsidianConfluenceSyncSettings,
		private readonly appendDebugInfo: (lines: string[]) => void,
		private readonly formatError: (error: unknown, requestUrlValue?: string) => string
	) {}

	normalizeEndpoint(endpoint: string): URL {
		const trimmed = endpoint.trim();
		return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	}

	buildS3RequestUrl(objectKey: string): URL {
		const endpoint = this.normalizeEndpoint(this.getSettings().attachmentSync.s3.endpoint);
		const bucket = this.getSettings().attachmentSync.s3.bucket.trim();
		const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
		if (this.getSettings().attachmentSync.s3.forcePathStyle) {
			endpoint.pathname = `/${bucket}/${encodedKey}`;
			return endpoint;
		}
		endpoint.hostname = `${bucket}.${endpoint.hostname}`;
		endpoint.pathname = `/${encodedKey}`;
		return endpoint;
	}

	buildS3ObjectUrl(objectKey: string): string {
		const publicBaseUrl = this.getSettings().attachmentSync.s3.publicBaseUrl.trim();
		const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
		if (publicBaseUrl) {
			return `${publicBaseUrl.replace(/\/+$/, '')}/${encodedKey}`;
		}
		return this.buildS3RequestUrl(objectKey).toString();
	}

	async uploadAttachmentToS3(file: TFile, objectKey: string): Promise<string> {
		const binaryContents = await this.app.vault.adapter.readBinary(file.path);
		const mimeType = this.getMimeType(file.extension);
		await this.uploadBufferToS3(objectKey, binaryContents, mimeType);
		this.appendDebugInfo([
			`S3 upload success: ${file.name}`,
			`S3 object key: ${objectKey}`
		]);
		return this.buildS3ObjectUrl(objectKey);
	}

	async uploadBufferToS3(objectKey: string, binaryContents: ArrayBuffer, mimeType: string): Promise<void> {
		const url = this.buildS3RequestUrl(objectKey);
		const body = Buffer.from(binaryContents);
		const headers = this.createAwsV4SignedHeaders('PUT', url, body, mimeType);
		await sendBinaryRequest({
			url: url.toString(),
			method: 'PUT',
			headers,
			body
		}, `Upload attachment to S3 ${objectKey}`, this.formatError);
	}

	createAwsV4SignedHeaders(method: string, requestUrlValue: URL, body: Buffer, mimeType: string): Record<string, string> {
		const s3 = this.getSettings().attachmentSync.s3;
		const region = s3.region.trim() || 'us-east-1';
		const host = requestUrlValue.host;
		const amzDate = this.formatAwsDate(new Date());
		const dateStamp = amzDate.slice(0, 8);
		const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
		const canonicalUri = requestUrlValue.pathname || '/';
		const canonicalHeaders = `content-type:${mimeType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
		const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
		const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
		const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			amzDate,
			credentialScope,
			crypto.createHash('sha256').update(canonicalRequest).digest('hex')
		].join('\n');
		const signingKey = this.getAwsSigningKey(s3.secretAccessKey, dateStamp, region, 's3');
		const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
		return {
			Host: host,
			'Content-Type': mimeType,
			'Content-Length': String(body.length),
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
			Authorization: `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		};
	}

	getAwsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
		const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
		const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
		const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
		return crypto.createHmac('sha256', kService).update('aws4_request').digest();
	}

	formatAwsDate(date: Date): string {
		return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
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
