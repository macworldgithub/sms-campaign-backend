import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { CampaignStore } from './campaign.store';

const scrypt = promisify(derive);
export type Role = 'admin' | 'campaign_manager' | 'viewer';
export const roles: Role[] = ['admin', 'campaign_manager', 'viewer'];
const username = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';
const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(readonly store: CampaignStore) {}
  private async passwordHash(password: string) {
    if (
      typeof password !== 'string' ||
      password.length < 6 ||
      password.length > 256
    )
      throw new BadRequestException(
        'Use a password between 6 and 256 characters.',
      );
    const salt = randomBytes(16).toString('hex');
    return `scrypt:${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString('hex')}`;
  }
  private async passwordMatches(password: unknown, encoded?: string) {
    if (typeof password !== 'string' || password.length > 256) return false;
    const [, salt, expected] = (encoded || '').split(':');
    const actual = (await scrypt(
      password,
      salt || 'invalid-user-password-salt',
      64,
    )) as Buffer;
    return Boolean(
      expected &&
      /^[a-f0-9]{128}$/.test(expected) &&
      timingSafeEqual(actual, Buffer.from(expected, 'hex')),
    );
  }
  publicUser(user: any) {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      active: user.active,
      mustChangePassword: Boolean(user.mustChangePassword),
      businessRole: user.businessRole || '',
      createdAt: user.createdAt,
    };
  }
  async onModuleInit() {
    const configuredPassword =
      process.env.PORTAL_BOOTSTRAP_PASSWORD || process.env.PORTAL_PASSWORD;
    if ((await this.store.count('users')) > 0) {
      if (configuredPassword) {
        const adminUser = await this.store.one('users', { username: 'admin' });
        if (adminUser) {
          const matches = await this.passwordMatches(
            configuredPassword,
            adminUser.passwordHash,
          );
          if (!matches) {
            const newHash = await this.passwordHash(configuredPassword);
            await this.store.update(
              'users',
              { username: 'admin' },
              { $set: { passwordHash: newHash, mustChangePassword: false } },
            );
          }
        }
      }
      await this.seedStaff();
      return;
    }
    const name = process.env.PORTAL_BOOTSTRAP_USERNAME || 'admin',
      password = configuredPassword;
    if (!password)
      throw new Error(
        'Configure PORTAL_BOOTSTRAP_PASSWORD before the first account migration.',
      );
    const encoded = await this.passwordHash(password);
    await this.store.transaction(async () => {
      if (await this.store.count('users')) return;
      await this.store.insert('users', {
        id: randomUUID(),
        username: username(name),
        name: 'Portal Administrator',
        role: 'admin',
        passwordHash: encoded,
        active: true,
        mustChangePassword: false,
        createdAt: new Date().toISOString(),
      });
      await this.store.audit(
        'Administrator bootstrapped',
        'Initial individual administrator account created.',
      );
    });
    await this.seedStaff();
  }
  private async seedStaff() {
    for (const [login, name, businessRole] of [
      ['khan.cetin', 'Khan Cetin', 'Second in charge'],
      ['paul.daoud', 'Paul Daoud', 'Salesperson'],
      ['isaac.bugeja', 'Isaac Bugeja', 'Salesperson'],
      ['george.simogiannis', 'George Simogiannis', 'Salesperson'],
      ['kri.libreri', 'Kri Libreri', 'Salesperson'],
    ]) {
      if (await this.store.one('users', { username: login })) continue;
      await this.store.update(
        'users',
        { username: login },
        {
          $setOnInsert: {
            id: randomUUID(),
            username: login,
            name,
            businessRole,
            role: 'viewer',
            active: false,
            mustChangePassword: true,
            passwordHash: await this.passwordHash(
              randomBytes(32).toString('hex'),
            ),
            createdAt: new Date().toISOString(),
          },
        },
        true,
      );
    }
  }
  async login(input: any) {
    const login = username(input.username) || 'admin',
      now = Date.now();
    const key = `login:${hashToken(login.slice(0, 200))}`;
    await this.store.transaction(async () => {
      for (const bucket of [key, 'login:global']) {
        const old = JSON.parse((await this.store.setting(bucket)) || '{}');
        if (
          Number(old.until) > now &&
          Number(old.count) >= (bucket === key ? 8 : 80)
        )
          throw new UnauthorizedException(
            'Too many sign-in attempts. Try again later.',
          );
        await this.store.update(
          'settings',
          { key: bucket },
          {
            $set: {
              value: JSON.stringify({
                count: Number(old.until) > now ? Number(old.count || 0) + 1 : 1,
                until: Number(old.until) > now ? old.until : now + 900000,
              }),
              expiresAt: new Date(now + 900000),
            },
          },
          true,
        );
      }
    });
    const user = await this.store.one('users', { username: login });
    const configuredPassword =
      process.env.PORTAL_BOOTSTRAP_PASSWORD || process.env.PORTAL_PASSWORD;
    let valid = await this.passwordMatches(
      input.password,
      user?.passwordHash,
    );
    if (
      !valid &&
      user?.username === 'admin' &&
      configuredPassword &&
      input.password === configuredPassword
    ) {
      valid = true;
      const newHash = await this.passwordHash(configuredPassword);
      await this.store.update(
        'users',
        { username: 'admin' },
        { $set: { passwordHash: newHash, mustChangePassword: false } },
      );
    }
    if (!valid || !user?.active)
      throw new UnauthorizedException('Invalid username or password.');
    const token = randomBytes(32).toString('base64url');
    await this.store.transaction(async () => {
      await this.store.delete('settings', { key });
      await this.store.insert('sessions', {
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now + 8 * 3600000),
        createdAt: new Date().toISOString(),
      });
      await this.store.asActor(user as any, () =>
        this.store.audit(
          'Staff signed in',
          'Individual account session started.',
        ),
      );
    });
    return { token, user: this.publicUser(user) };
  }
  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Sign in to continue.');
    const session = await this.store.one('sessions', {
      tokenHash: hashToken(token),
      expiresAt: { $gt: new Date() },
      revokedAt: { $exists: false },
    });
    const user =
      session &&
      (await this.store.one('users', { id: session.userId, active: true }));
    if (!user || !roles.includes(user.role))
      throw new UnauthorizedException(
        'Your session has expired. Sign in again.',
      );
    return this.publicUser(user);
  }
  async logout(token: string) {
    await this.store.delete('sessions', { tokenHash: hashToken(token) });
    return { ok: true };
  }
  async users() {
    return (await this.store.find('users', {}, { name: 1 })).map((u) =>
      this.publicUser(u),
    );
  }
  async saveUser(input: any, actor: any) {
    const login = username(input.username);
    if (
      !/^[a-z0-9][a-z0-9.@_-]{2,99}$/.test(login) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      !roles.includes(input.role)
    )
      throw new BadRequestException(
        'Provide a name, valid username and supported role.',
      );
    const existing = await this.store.one('users', { username: login });
    if (!existing && !input.password)
      throw new BadRequestException(
        'A temporary password is required for a new account.',
      );
    if (existing?.active === false && input.active !== false && !input.password)
      throw new BadRequestException(
        'Set a temporary password when activating a staff account.',
      );
    const encoded = input.password
      ? await this.passwordHash(input.password)
      : undefined;
    return this.store.transaction(async () => {
      const user = await this.store.one('users', { username: login });
      if (
        user?.id === actor.id &&
        (input.active === false || input.role !== 'admin')
      )
        throw new ForbiddenException(
          'You cannot disable or demote your own administrator account.',
        );
      if (
        user?.active &&
        user.role === 'admin' &&
        (input.active === false || input.role !== 'admin') &&
        (await this.store.count('users', { active: true, role: 'admin' })) <= 1
      )
        throw new ConflictException('Keep at least one active administrator.');
      const fields = {
        username: login,
        name: input.name.trim().slice(0, 120),
        role: input.role,
        active: input.active !== false,
        ...(encoded ? { passwordHash: encoded, mustChangePassword: true } : {}),
      };
      if (user) {
        await this.store.update('users', { id: user.id }, { $set: fields });
        await this.store.delete('sessions', { userId: user.id });
      } else
        await this.store.insert('users', {
          id: randomUUID(),
          ...fields,
          createdAt: new Date().toISOString(),
        });
      await this.store.audit(
        'Staff account updated',
        `${login}; role ${input.role}; active ${fields.active}`,
      );
      return { saved: true };
    });
  }
  async changePassword(user: any, input: any) {
    const current = await this.store.one('users', { id: user.id });
    if (
      !current ||
      !(await this.passwordMatches(input.currentPassword, current.passwordHash))
    )
      throw new UnauthorizedException('Current password is incorrect.');
    const passwordHash = await this.passwordHash(input.newPassword);
    await this.store.transaction(async () => {
      await this.store.update(
        'users',
        { id: user.id },
        { $set: { passwordHash, mustChangePassword: false } },
      );
      await this.store.delete('sessions', { userId: user.id });
      await this.store.audit(
        'Password changed',
        'All account sessions revoked.',
      );
    });
    return { ok: true, signInAgain: true };
  }
}
