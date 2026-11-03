import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';

export type StoredFile = { name: string; content: string; encoding?: 'base64' };
export type ProjectData = {
  id: string;
  name: string;
  modified: number;
  files: StoredFile[];
  mainFile?: string;
  archived?: boolean;
  settings?: unknown;
  versions?: unknown[];
  comments?: unknown[];
  changes?: unknown[];
};
export type ProjectUpdate = Omit<Partial<ProjectData>, 'id' | 'modified'>;

const env = process.env;
const cloudValues = [env.DATABASE_URL, env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET];
const anyCloudValue = cloudValues.some(Boolean);
const completeCloudConfig = cloudValues.every(Boolean);

/** Metadata is stored in Postgres; each project's source tree and generated artifacts live in R2. */
export class ProjectPersistence {
  readonly mode: 'local' | 'neon-r2';
  readonly ready: boolean;
  private pool?: Pool;
  private s3?: S3Client;
  private bucket?: string;

  constructor() {
    if (anyCloudValue && !completeCloudConfig) throw new Error('Production storage needs DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.');
    this.mode = completeCloudConfig ? 'neon-r2' : 'local';
    this.ready = this.mode === 'local';
    if (this.mode === 'neon-r2') {
      this.pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, idleTimeoutMillis: 15_000, connectionTimeoutMillis: 10_000, ssl: { rejectUnauthorized: true } });
      this.bucket = env.R2_BUCKET;
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
        maxAttempts: 2,
      });
    }
  }

  async initialize() {
    if (this.mode === 'local') return;
    await this.pool!.query(`CREATE TABLE IF NOT EXISTS paperdesk_projects (
      id text PRIMARY KEY,
      owner_id text NOT NULL,
      name text NOT NULL,
      modified bigint NOT NULL,
      main_file text,
      archived boolean,
      settings jsonb,
      versions jsonb,
      comments jsonb,
      changes jsonb,
      object_key text NOT NULL
    )`);
    await this.pool!.query('ALTER TABLE paperdesk_projects ADD COLUMN IF NOT EXISTS owner_id text');
    await this.pool!.query("UPDATE paperdesk_projects SET owner_id = 'legacy' WHERE owner_id IS NULL");
    await this.pool!.query('ALTER TABLE paperdesk_projects ALTER COLUMN owner_id SET NOT NULL');
    await this.s3!.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async list(ownerId: string): Promise<ProjectData[]> {
    const { rows } = await this.pool!.query('SELECT * FROM paperdesk_projects WHERE owner_id = $1 ORDER BY modified DESC', [ownerId]);
    return Promise.all(rows.map(row => this.readRow(row)));
  }

  async read(id: string, ownerId: string): Promise<ProjectData> {
    const { rows } = await this.pool!.query('SELECT * FROM paperdesk_projects WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!rows[0]) throw new Error('Project not found');
    return this.readRow(rows[0]);
  }

  async write(id: string, ownerId: string, update: ProjectUpdate): Promise<ProjectData> {
    const previous = await this.read(id, ownerId).catch(() => null);
    const files = update.files ?? previous?.files ?? [];
    const name = update.name ?? previous?.name ?? 'Untitled Project';
    const objectKey = `projects/${ownerId}/${id}/source.json`;
    const json = JSON.stringify(files);
    await this.s3!.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: json, ContentType: 'application/json' }));
    const value = <K extends 'mainFile' | 'archived' | 'settings' | 'versions' | 'comments' | 'changes'>(key: K): ProjectData[K] => (update[key] !== undefined ? update[key] : previous?.[key]) as ProjectData[K];
    const modified = Date.now();
    const saved = await this.pool!.query(`INSERT INTO paperdesk_projects (id,owner_id,name,modified,main_file,archived,settings,versions,comments,changes,object_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, modified=EXCLUDED.modified, main_file=EXCLUDED.main_file,
      archived=EXCLUDED.archived, settings=EXCLUDED.settings, versions=EXCLUDED.versions,
      comments=EXCLUDED.comments, changes=EXCLUDED.changes, object_key=EXCLUDED.object_key
      WHERE paperdesk_projects.owner_id = EXCLUDED.owner_id RETURNING id`,
    [id, ownerId, name, modified, value('mainFile') ?? null, value('archived') ?? null, value('settings') ?? null, value('versions') ?? null, value('comments') ?? null, value('changes') ?? null, objectKey]);
    if (!saved.rowCount) throw new Error('Project not found');
    return { id, name, modified, files, mainFile: value('mainFile'), archived: value('archived'), settings: value('settings'), versions: value('versions'), comments: value('comments'), changes: value('changes') };
  }

  async delete(id: string, ownerId: string) {
    const { rowCount } = await this.pool!.query('DELETE FROM paperdesk_projects WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!rowCount) return;
    const prefix = `projects/${ownerId}/${id}`;
    const keys = [`${prefix}/source.json`, `${prefix}/artifacts/compiled.pdf`, `${prefix}/artifacts/synctex.gz`];
    await Promise.all(keys.map(Key => this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))));
  }

  async putArtifact(id: string, ownerId: string, name: 'compiled.pdf' | 'synctex.gz', body: Buffer) {
    await this.s3!.send(new PutObjectCommand({ Bucket: this.bucket, Key: `projects/${ownerId}/${id}/artifacts/${name}`, Body: body, ContentType: name.endsWith('.pdf') ? 'application/pdf' : 'application/gzip' }));
  }

  async getArtifact(id: string, ownerId: string, name: 'compiled.pdf' | 'synctex.gz') {
    const result = await this.s3!.send(new GetObjectCommand({ Bucket: this.bucket, Key: `projects/${ownerId}/${id}/artifacts/${name}` }));
    if (!result.Body) throw new Error('Stored artifact is empty');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async deleteArtifacts(id: string, ownerId: string) {
    await Promise.all(['compiled.pdf', 'synctex.gz'].map(name => this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `projects/${ownerId}/${id}/artifacts/${name}` }))));
  }

  private async readRow(row: Record<string, unknown>): Promise<ProjectData> {
    const result = await this.s3!.send(new GetObjectCommand({ Bucket: this.bucket, Key: String(row.object_key) }));
    const files = JSON.parse(await result.Body!.transformToString('utf-8')) as StoredFile[];
    return {
      id: String(row.id), name: String(row.name), modified: Number(row.modified), files,
      ...(row.main_file ? { mainFile: String(row.main_file) } : {}),
      ...(row.archived === null ? {} : { archived: Boolean(row.archived) }),
      ...(row.settings === null ? {} : { settings: row.settings }),
      ...(row.versions === null ? {} : { versions: row.versions as unknown[] }),
      ...(row.comments === null ? {} : { comments: row.comments as unknown[] }),
      ...(row.changes === null ? {} : { changes: row.changes as unknown[] }),
    };
  }
}
