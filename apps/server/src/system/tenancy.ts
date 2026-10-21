// Tenancy service (P1-T1 step 1): creates accounts with their vaults, and turns a session's user into the binding of
// that user's OWN vault — the only database a vault route can ever reach (ARCHITECTURE_DELTA §5.5 gate 2).
import { rmSync } from 'node:fs';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import type { Clock } from '../lib/time';
import type { Binding, DbBinding, TenantBinding, Viewer } from './binding';
import type { DatabasePool } from './pool';
import type { SystemRepos, UserRow, VaultRow } from './repos';

/**
 * An account whose vault cannot be opened right now (locked for a restore or a migration, being deleted, missing).
 * Signing in again does not help, so the message says so instead of «sign in again».
 */
export const ACCOUNT_UNAVAILABLE_AR = 'حسابك غير متاح حاليًا: بياناته قيد الصيانة أو الحذف. أعد المحاولة لاحقًا أو تواصل مع مسؤول المنصة.';
export function accountUnavailableError(): AppError {
  return new AppError('UNAUTHENTICATED', ACCOUNT_UNAVAILABLE_AR, 401);
}

export interface NewAccount {
  username: string;
  displayName: string;
  passwordHash: string;
  recoveryHashes: string[];
  isPlatformAdmin: boolean;
  timezone: string;
}

export class Tenancy {
  constructor(
    private readonly system: SystemRepos,
    private readonly pool: DatabasePool,
    private readonly binding: TenantBinding,
    private readonly clock: Clock,
  ) {}

  viewerOf(user: Pick<UserRow, 'id' | 'is_platform_admin'>, deviceId: string | null): Viewer {
    return { userId: user.id, deviceId, isPlatformAdmin: user.is_platform_admin === 1 };
  }

  /**
   * Create an account and its vault. The vault file is created first (from the migrated template, atomically), then
   * the account, profile and registry rows in ONE system transaction; if that fails the new, empty file is removed.
   * A crash between the two leaves an unregistered empty file in vaults/, which nothing ever opens.
   */
  createAccount(input: NewAccount, opts: { onlyIfNoUsers?: boolean } = {}): { user: UserRow; vault: VaultRow } {
    const vaultId = newId(this.clock.now());
    const dbFile = this.pool.createFile('vault', vaultId);
    try {
      return this.system.db.tx(() => {
        if (opts.onlyIfNoUsers && this.system.users.countInternal() > 0) {
          throw new AppError('ALREADY_SET_UP', 'تم إعداد الحساب الأول مسبقًا. لا يمكن إنشاؤه مرة أخرى؛ سجّل الدخول بدلًا من ذلك.', 409);
        }
        if (this.system.users.findForAuth(input.username)) {
          throw new AppError('CONFLICT', 'اسم المستخدم مستخدم من قبل. اختر اسمًا آخر.', 409);
        }
        const user = this.system.users.createInternal({ ...input });
        const vault = this.system.vaults.registerInternal({ id: vaultId, userId: user.id, dbFile });
        return { user, vault };
      });
    } catch (e) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.pool.pathOfFile('vault', dbFile)}${suffix}`, { force: true });
      throw e;
    }
  }

  /** The binding of the viewer's OWN vault (the binding hook's only vault binding). */
  vaultBindingFor(viewer: Viewer): Extract<Binding, { kind: 'vault' }> {
    const b = this.vaultBindingOrNull(viewer);
    if (!b) throw accountUnavailableError();
    return b;
  }

  /** The viewer's own vault binding, or null while that vault cannot be used (locked, being deleted, missing). */
  vaultBindingOrNull(viewer: Viewer): Extract<Binding, { kind: 'vault' }> | null {
    const vault = this.system.vaults.ofUserInternal(viewer.userId);
    if (!vault || vault.status !== 'active') return null;
    return { kind: 'vault', vaultId: vault.id, viewer };
  }

  /** Does more than one database share the content-addressed file store (several accounts, or spaces)? */
  sharesFileStore(): boolean {
    return this.system.vaults.databaseCountInternal() > 1;
  }

  /**
   * Has this deployment EVER held more than one database? A whole-instance archive made back then still holds every
   * account of that time — deleted ones too (P1-T1 step 2 review), so it never leaves the server in clear again.
   */
  hasHadSeveralDatabases(): boolean {
    return this.system.vaults.everRegisteredCountInternal() > 1;
  }

  /** Can this account's vault be used right now? (sign-in refuses with the reason otherwise) */
  vaultUsable(userId: string): boolean {
    return this.system.vaults.ofUserInternal(userId)?.status === 'active';
  }

  /**
   * Step 1 interim: the bookkeeping of platform operations (whole-instance backups, off-site runs, evaluation runs)
   * still lives in base tables, so it is kept in the vault of the FIRST platform admin (user #1). Null before setup.
   */
  platformVaultBinding(): Extract<Binding, { kind: 'vault' }> | null {
    const admin = this.system.db.get<{ id: string }>(`SELECT id FROM user_account WHERE is_platform_admin = 1 AND status = 'active' ORDER BY created_at, id LIMIT 1`);
    if (!admin) return null;
    const vault = this.system.vaults.ofUserInternal(admin.id);
    if (!vault || vault.status !== 'active') return null;
    return { kind: 'vault', vaultId: vault.id, viewer: null };
  }

  /** What a signed file link issued here carries: the current database and user (null outside a database). */
  fileTokenScope(): { db: string; userId: string | null } | null {
    const b = this.binding.current() ?? this.binding.harnessDefault();
    if (!b || b.kind === 'root') return null;
    const viewer = b.viewer ?? null;
    if (b.kind === 'vault') {
      const owner = viewer?.userId ?? this.system.vaults.byIdInternal(b.vaultId)?.user_id ?? null;
      return { db: `v:${b.vaultId}`, userId: owner };
    }
    return { db: `s:${b.spaceId}`, userId: viewer?.userId ?? null };
  }

  /**
   * The binding a signed file link may use: its vault, only while the vault is active and still belongs to the
   * user named in the link, and that user is active. Spaces get their own rule with official files (R1-c): refused.
   */
  bindingForFileToken(db: string, userId: string | null): DbBinding | null {
    if (!db.startsWith('v:') || userId === null) return null;
    const vault = this.system.vaults.byIdInternal(db.slice(2));
    if (!vault || vault.status !== 'active' || vault.user_id !== userId) return null;
    const user = this.system.users.byIdInternal(userId);
    if (!user || user.status !== 'active') return null;
    return { kind: 'vault', vaultId: vault.id, viewer: null };
  }

  /** Run `fn` inside a vault as background work (no viewer). */
  inVault<T>(vaultId: string, fn: () => T): T {
    return this.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
  }
}
