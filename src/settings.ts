export type AttachmentSyncMode = 'wiki' | 's3';

export interface S3AttachmentSettings {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
	publicBaseUrl: string;
}

export interface AttachmentSyncSettings {
	mode: AttachmentSyncMode;
	replaceLinksWhenS3: boolean;
	deleteLocalAfterUpload: boolean;
	filePatterns: string[];
	pathPrefixTemplate: string;
	projectFieldName: string;
	defaultProject: string;
	s3: S3AttachmentSettings;
}

export interface ObsidianConfluenceSyncSettings {
	confluenceHost: string;
	personalAccessToken: string;
	username: string;
	password: string;
	parentPageId: string;
	pageIdFieldName: string;
	wikiFieldName: string;
	attachmentSync: AttachmentSyncSettings;
	mapping?: { [key: string]: string };
}

export const DEFAULT_ATTACHMENT_SYNC_SETTINGS: AttachmentSyncSettings = {
	mode: 'wiki',
	replaceLinksWhenS3: true,
	deleteLocalAfterUpload: false,
	filePatterns: [],
	pathPrefixTemplate: '{project}/{yyyy}/{MM}/{dd}/{filename}',
	projectFieldName: 'project',
	defaultProject: 'default',
	s3: {
		endpoint: '',
		region: 'us-east-1',
		bucket: '',
		accessKeyId: '',
		secretAccessKey: '',
		forcePathStyle: true,
		publicBaseUrl: ''
	}
};

export const DEFAULT_SETTINGS: ObsidianConfluenceSyncSettings = {
	confluenceHost: '',
	personalAccessToken: '',
	username: '',
	password: '',
	parentPageId: '',
	pageIdFieldName: 'confluencePageId',
	wikiFieldName: 'wiki',
	attachmentSync: DEFAULT_ATTACHMENT_SYNC_SETTINGS,
	mapping: {}
};
