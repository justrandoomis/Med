// Helpers of the P1-T4 channel tests: a test app whose user #1 («owner») is the platform admin, extra accounts, and
// thin wrappers around the /api/channels routes. Everything goes through the real routes (the binding hook, the guard,
// the authz policy), never around them.
import type { LightMyRequestResponse } from 'fastify';
import type { ChannelKind, ChannelNodeView, ChannelRole, CreateJoinCodeResponse, JoinPolicy } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type CreateTestAppOptions, CSRF, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

export interface ChannelWorld {
  t: TestApp;
  /** user #1, the platform admin */
  pa: AuthHeaders;
  close(): Promise<void>;
}

export async function channelWorld(opts: CreateTestAppOptions = {}): Promise<ChannelWorld> {
  const t = await createTestApp(opts);
  const pa = await t.login();
  return { t, pa, close: () => t.close() };
}

export type Http = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';

export function call(t: TestApp, h: AuthHeaders | null, method: Http, url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(h ?? CSRF), ...extra };
  return t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

export function ok<T>(res: LightMyRequestResponse): T {
  if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

export async function createNode(
  t: TestApp,
  h: AuthHeaders,
  parentId: string | null,
  kind: ChannelKind,
  title: string,
  extra: { join_policy?: JoinPolicy; title_en?: string; ordinal?: number; starts_on?: string; ends_on?: string } = {},
): Promise<ChannelNodeView> {
  return ok<ChannelNodeView>(await call(t, h, 'POST', '/api/channels/nodes', { parent_id: parentId, kind, title, ...extra }));
}

export async function createCode(
  t: TestApp,
  h: AuthHeaders,
  nodeId: string,
  body: { kind?: 'class_code' | 'invite_link'; expires_in_hours?: number; max_uses?: number; requires_approval?: boolean } = {},
): Promise<CreateJoinCodeResponse> {
  return ok<CreateJoinCodeResponse>(
    await call(t, h, 'POST', `/api/channels/nodes/${nodeId}/codes`, { kind: body.kind ?? 'class_code', expires_in_hours: body.expires_in_hours ?? 24, requires_approval: body.requires_approval ?? true, ...(body.max_uses ? { max_uses: body.max_uses } : {}) }),
  );
}

export async function assignRole(t: TestApp, h: AuthHeaders, nodeId: string, userId: string, role: ChannelRole): Promise<{ id: string }> {
  return ok<{ id: string }>(await call(t, h, 'POST', `/api/channels/nodes/${nodeId}/roles`, { user_id: userId, role }));
}

export interface Person extends ExtraUser {
  h: AuthHeaders;
}

export async function person(t: TestApp, username: string): Promise<Person> {
  const u = await addUser(t, username);
  return Object.assign(u, { h: await u.login() });
}

/** The body Fastify answers for a route that does not exist — what a hidden resource must look like. */
export async function missingRouteBody(t: TestApp, h: AuthHeaders | null): Promise<string> {
  const res = await call(t, h, 'GET', '/api/channels/this-route-does-not-exist');
  if (res.statusCode !== 404) throw new Error(`expected 404 for a missing route, got ${res.statusCode}`);
  return res.body;
}
