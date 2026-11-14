import crypto from 'node:crypto';
import type { Pool } from 'pg';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly string[] = ['editor', 'viewer'];
const VIEWER_POST = new Set(['/compile', '/synctex', '/wordcount', '/export']);

/**
 * Whether a role may make this request on a project; `sub` is the path after the project id. Deny by default, so a
 * new route is closed to invited people until it is listed here.
 */
export function roleAllows(role: Role, method: string, sub: string) {
  if (role === 'owner') return true;
  const path = sub.replace(/\/+$/, '');
  if (path.startsWith('/members') || path.startsWith('/invites')) return false;
  if (method === 'GET') return true;
  // Everyone on a project can use its chat and mention people.
  if (/^\/(chat(\/[\w-]+)?|mentions)$/.test(path)) return true;
  if (method === 'POST' && VIEWER_POST.has(path)) return true;
  if (role !== 'editor') return false;
  if (method === 'PUT') return path === '' || /^\/files\/[^/]+$/.test(path) || /^\/history\/\d+$/.test(path);
  if (method === 'POST')
    return (
      ['/files', '/upload', '/share', '/github/link', '/github/push', '/github/pull'].includes(path) ||
      /^\/history\/\d+\/restore$/.test(path)
    );
  if (method === 'DELETE') return /^\/files\/[^/]+$/.test(path) || path === '/cache' || path === '/github/link';
  return false;
}

export type FileLike = { name: string; content?: string; encoding?: string };
const MAX_HISTORY_FILE = 2 * 1024 * 1024;
const BUCKET_MS = 5 * 60_000;
const KEEP_UNNAMED = 100;
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Members, invites, link tokens and per-file history, in the same Postgres database as the projects. */
export class SharingStore {
  constructor(private pool: Pool) {}

  async initialize() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS paperdesk_shares (alias text PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, UNIQUE (owner_id, project_id));
      CREATE TABLE IF NOT EXISTS paperdesk_project_members (alias text NOT NULL REFERENCES paperdesk_shares ON DELETE CASCADE, user_id text NOT NULL, email text, role text NOT NULL, added bigint NOT NULL, PRIMARY KEY (alias, user_id));
      CREATE INDEX IF NOT EXISTS paperdesk_members_user ON paperdesk_project_members (user_id);
      CREATE TABLE IF NOT EXISTS paperdesk_invites (token text PRIMARY KEY, alias text NOT NULL REFERENCES paperdesk_shares ON DELETE CASCADE, email text, role text NOT NULL, created bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS paperdesk_file_versions (id bigserial PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, file text NOT NULL, content text NOT NULL, hash text NOT NULL, author text, name text, created bigint NOT NULL);
      CREATE INDEX IF NOT EXISTS paperdesk_versions_file ON paperdesk_file_versions (owner_id, project_id, file, id DESC);`);
  }

  /** The stable id invited people use: project ids are only unique per owner. */
  private async aliasFor(ownerId: string, projectId: string) {
    const { rows } = await this.pool.query(
      `INSERT INTO paperdesk_shares (alias, owner_id, project_id) VALUES ($1,$2,$3)
      ON CONFLICT (owner_id, project_id) DO UPDATE SET owner_id = EXCLUDED.owner_id RETURNING alias`,
      [`s-${crypto.randomBytes(12).toString('hex')}`, ownerId, projectId],
    );
    return String(rows[0].alias);
  }

  async resolve(alias: string, userId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.owner_id, s.project_id, m.role FROM paperdesk_shares s JOIN paperdesk_project_members m USING (alias) WHERE s.alias = $1 AND m.user_id = $2`,
      [alias, userId],
    );
    return rows[0]
      ? { ownerId: String(rows[0].owner_id), projectId: String(rows[0].project_id), role: rows[0].role as Role }
      : null;
  }

  async memberships(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.alias, s.owner_id, s.project_id, m.role FROM paperdesk_project_members m JOIN paperdesk_shares s USING (alias) WHERE m.user_id = $1`,
      [userId],
    );
    return rows.map((r) => ({
      alias: String(r.alias),
      ownerId: String(r.owner_id),
      projectId: String(r.project_id),
      role: r.role as Role,
    }));
  }

  /** This owner's shared projects: project id to the stable id used in project links, and whether anyone was invited. */
  async sharedIds(ownerId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.project_id, s.alias, (EXISTS (SELECT 1 FROM paperdesk_project_members m WHERE m.alias = s.alias) OR EXISTS (SELECT 1 FROM paperdesk_invites i WHERE i.alias = s.alias)) AS shared FROM paperdesk_shares s WHERE s.owner_id = $1`,
      [ownerId],
    );
    return new Map(rows.map((r) => [String(r.project_id), { alias: String(r.alias), shared: r.shared === true }]));
  }

  /** Email invitations for this person's address become memberships, so the project link alone opens the project. */
  async claimEmailInvites(user: { id: string; ownerId: string; email?: string }) {
    const email = user.email?.toLowerCase();
    if (!email) return;
    const { rows } = await this.pool.query('SELECT token FROM paperdesk_invites WHERE email = $1', [email]);
    for (const r of rows) await this.accept(String(r.token), user);
  }

  async access(ownerId: string, projectId: string) {
    const alias = await this.aliasFor(ownerId, projectId);
    const [members, invites] = await Promise.all([
      this.pool.query('SELECT user_id, email, role FROM paperdesk_project_members WHERE alias = $1 ORDER BY added', [
        alias,
      ]),
      this.pool.query('SELECT token, email, role FROM paperdesk_invites WHERE alias = $1 ORDER BY created', [alias]),
    ]);
    return {
      alias,
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, role: m.role })),
      invites: invites.rows,
    };
  }

  /** An email invite works once, for that address; a link (no email) works for anyone until revoked. */
  async createInvite(ownerId: string, projectId: string, role: string, email?: string) {
    const alias = await this.aliasFor(ownerId, projectId);
    const clean = email?.trim().toLowerCase() || null;
    if (!clean)
      await this.pool.query('DELETE FROM paperdesk_invites WHERE alias = $1 AND email IS NULL AND role = $2', [
        alias,
        role,
      ]);
    const token = newToken();
    await this.pool.query(
      'INSERT INTO paperdesk_invites (token, alias, email, role, created) VALUES ($1,$2,$3,$4,$5)',
      [token, alias, clean, role, Date.now()],
    );
    return { token, email: clean, role, alias };
  }

  async revokeInvite(ownerId: string, projectId: string, token: string) {
    await this.pool.query(
      'DELETE FROM paperdesk_invites i USING paperdesk_shares s WHERE i.alias = s.alias AND s.owner_id = $1 AND s.project_id = $2 AND i.token = $3',
      [ownerId, projectId, token],
    );
  }

  async setRole(ownerId: string, projectId: string, userId: string, role: string) {
    await this.pool.query(
      'UPDATE paperdesk_project_members m SET role = $4 FROM paperdesk_shares s WHERE m.alias = s.alias AND s.owner_id = $1 AND s.project_id = $2 AND m.user_id = $3',
      [ownerId, projectId, userId, role],
    );
  }

  async removeMember(ownerId: string, projectId: string, userId: string) {
    await this.pool.query(
      'DELETE FROM paperdesk_project_members m USING paperdesk_shares s WHERE m.alias = s.alias AND s.owner_id = $1 AND s.project_id = $2 AND m.user_id = $3',
      [ownerId, projectId, userId],
    );
  }

  async leave(alias: string, userId: string) {
    await this.pool.query('DELETE FROM paperdesk_project_members WHERE alias = $1 AND user_id = $2', [alias, userId]);
  }

  /** What an invitation is for, so the person opening the link can be told before they sign in. */
  async invitation(token: string) {
    const { rows } = await this.pool.query(
      `SELECT i.role, i.email, p.name FROM paperdesk_invites i JOIN paperdesk_shares s USING (alias)
      LEFT JOIN paperdesk_projects p ON p.id = s.project_id AND p.owner_id = s.owner_id WHERE i.token = $1`,
      [token],
    );
    return rows[0]
      ? { project: String(rows[0].name ?? 'a project'), role: String(rows[0].role), forEmail: !!rows[0].email }
      : null;
  }

  /** Returns the id to open, or an error status. Accepting again never lowers or raises an existing role. */
  async accept(token: string, user: { id: string; ownerId: string; email?: string }) {
    const { rows } = await this.pool.query(
      'SELECT i.alias, i.email, i.role, s.owner_id, s.project_id FROM paperdesk_invites i JOIN paperdesk_shares s USING (alias) WHERE i.token = $1',
      [token],
    );
    const invite = rows[0];
    if (!invite) return { status: 404, error: 'This invitation is no longer valid.' };
    if (invite.owner_id === user.ownerId) return { id: String(invite.project_id), role: 'owner' };
    if (invite.email && invite.email !== user.email?.toLowerCase())
      return { status: 403, error: `This invitation is for ${invite.email}. Sign in with that address.` };
    const saved = await this.pool.query(
      `INSERT INTO paperdesk_project_members (alias, user_id, email, role, added) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (alias, user_id) DO UPDATE SET email = EXCLUDED.email RETURNING role`,
      [invite.alias, user.id, user.email ?? null, invite.role, Date.now()],
    );
    if (invite.email) await this.pool.query('DELETE FROM paperdesk_invites WHERE token = $1', [token]);
    return { id: String(invite.alias), role: String(saved.rows[0].role) };
  }

  async dropProject(ownerId: string, projectId: string) {
    await this.pool.query('DELETE FROM paperdesk_shares WHERE owner_id = $1 AND project_id = $2', [ownerId, projectId]);
    await this.pool.query('DELETE FROM paperdesk_file_versions WHERE owner_id = $1 AND project_id = $2', [
      ownerId,
      projectId,
    ]);
  }

  /** Saves changed text files. One author's edits within a few minutes share a version; named ones are never changed. */
  async record(ownerId: string, projectId: string, files: FileLike[], author: string | null) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (file) id, file, hash, author, name, created FROM paperdesk_file_versions
      WHERE owner_id = $1 AND project_id = $2 ORDER BY file, id DESC`,
      [ownerId, projectId],
    );
    const latest = new Map(rows.map((r) => [String(r.file), r]));
    const now = Date.now();
    for (const file of files) {
      if (
        file.encoding === 'base64' ||
        file.name.endsWith('/') ||
        typeof file.content !== 'string' ||
        file.content.length > MAX_HISTORY_FILE
      )
        continue;
      const previous = latest.get(file.name),
        sum = hash(file.content);
      if (previous?.hash === sum) continue;
      if (previous && !previous.name && previous.author === author && now - Number(previous.created) < BUCKET_MS) {
        await this.pool.query('UPDATE paperdesk_file_versions SET content = $1, hash = $2 WHERE id = $3', [
          file.content,
          sum,
          previous.id,
        ]);
        continue;
      }
      await this.insertVersion(ownerId, projectId, file.name, file.content, author, null);
      await this.pool.query(
        `DELETE FROM paperdesk_file_versions WHERE id IN (SELECT id FROM paperdesk_file_versions WHERE owner_id = $1 AND project_id = $2 AND file = $3 AND name IS NULL ORDER BY id DESC OFFSET $4)`,
        [ownerId, projectId, file.name, KEEP_UNNAMED],
      );
    }
  }

  async insertVersion(
    ownerId: string,
    projectId: string,
    file: string,
    content: string,
    author: string | null,
    name: string | null,
  ) {
    const { rows } = await this.pool.query(
      `INSERT INTO paperdesk_file_versions (owner_id, project_id, file, content, hash, author, name, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ownerId, projectId, file, content, hash(content), author, name, Date.now()],
    );
    return String(rows[0].id);
  }

  async versions(ownerId: string, projectId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, file, author, name, created FROM paperdesk_file_versions WHERE owner_id = $1 AND project_id = $2 ORDER BY id DESC LIMIT 500`,
      [ownerId, projectId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      file: String(r.file),
      author: r.author,
      name: r.name,
      created: Number(r.created),
    }));
  }

  async version(ownerId: string, projectId: string, id: string) {
    const { rows } = await this.pool.query(
      'SELECT id, file, content, author, name, created FROM paperdesk_file_versions WHERE id = $1 AND owner_id = $2 AND project_id = $3',
      [id, ownerId, projectId],
    );
    return rows[0]
      ? {
          id: String(rows[0].id),
          file: String(rows[0].file),
          content: String(rows[0].content),
          author: rows[0].author,
          name: rows[0].name,
          created: Number(rows[0].created),
        }
      : null;
  }

  async nameVersion(ownerId: string, projectId: string, id: string, name: string | null) {
    await this.pool.query(
      'UPDATE paperdesk_file_versions SET name = $4 WHERE id = $1 AND owner_id = $2 AND project_id = $3',
      [id, ownerId, projectId, name],
    );
  }
}
