import { AuthService } from './auth.service';
import { AccessGuard } from './access';
import { CampaignStore } from './campaign.store';
import { testStore, clearTestStore, closeTestStore } from './testing/mongo';

jest.setTimeout(60000);
describe('Individual staff access', () => {
  let store: CampaignStore, auth: AuthService;
  const original = { ...process.env };
  const key = 'test-private-portal-key-00000000000000000';
  beforeAll(async () => {
    store = await testStore();
  });
  beforeEach(async () => {
    Object.assign(process.env, {
      PORTAL_API_KEY: key,
      PORTAL_BOOTSTRAP_USERNAME: 'admin',
      PORTAL_BOOTSTRAP_PASSWORD: 'Test administrator password 123',
    });
    auth = new AuthService(store);
    await auth.onModuleInit();
  });
  afterEach(async () => {
    if (store) await clearTestStore(store);
    for (const k of Object.keys(process.env))
      if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
  });
  const context = (path: string, method: string, token = '') =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/api/' + path,
          method,
          headers: {
            'x-portal-key': key,
            authorization: 'Bearer ' + token,
            'x-user-role': 'admin',
          },
        }),
      }),
    }) as any;
  async function staff(role = 'viewer') {
    await auth.saveUser(
      {
        username: 'fixture.staff',
        name: 'Fixture Staff',
        role,
        active: true,
        password: 'Staff temporary password 123',
      },
      { id: 'admin-fixture' },
    );
    return auth.login({
      username: 'fixture.staff',
      password: 'Staff temporary password 123',
    });
  }
  it('hashes passwords and stores only session token digests', async () => {
    const login = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    const user = await store.one('users', { username: 'admin' }),
      session = await store.one('sessions', { userId: user!.id });
    expect(user?.passwordHash).toMatch(/^scrypt:/);
    expect(user?.passwordHash).not.toContain('Test administrator password');
    expect(session?.tokenHash).not.toBe(login.token);
    expect((await new AuthService(store).authenticate(login.token)).role).toBe(
      'admin',
    );
  });
  it('creates supplied staff records disabled without adding audience contacts', async () => {
    expect(await store.count('users', { active: false })).toBe(5);
    expect(await store.count('contacts')).toBe(0);
    await expect(
      auth.login({
        username: 'khan.cetin',
        password: 'not-the-random-password',
      }),
    ).rejects.toThrow();
  });
  it('requires first-login password change and revokes the temporary session', async () => {
    const login = await staff();
    const guard = new AccessGuard(auth);
    expect(login.user.mustChangePassword).toBe(true);
    await expect(
      guard.canActivate(context('portal', 'GET', login.token)),
    ).rejects.toThrow('Change your temporary password');
    await auth.changePassword(login.user, {
      currentPassword: 'Staff temporary password 123',
      newPassword: 'My new private staff password 456',
    });
    await expect(auth.authenticate(login.token)).rejects.toThrow();
    const next = await auth.login({
      username: 'fixture.staff',
      password: 'My new private staff password 456',
    });
    expect(next.user.mustChangePassword).toBe(false);
  });
  it('enforces viewer permissions on the server regardless of forged headers', async () => {
    const login = await staff();
    await store.update(
      'users',
      { id: login.user.id },
      { $set: { mustChangePassword: false } },
    );
    const guard = new AccessGuard(auth);
    expect(await guard.canActivate(context('portal', 'GET', login.token))).toBe(
      true,
    );
    await expect(
      guard.canActivate(context('campaigns', 'POST', login.token)),
    ).rejects.toThrow('read-only');
    await expect(
      guard.canActivate(context('users', 'GET', login.token)),
    ).rejects.toThrow('Administrator');
  });
  it('allows campaign managers to operate campaigns but not accounts or routing', async () => {
    const login = await staff('campaign_manager');
    await store.update(
      'users',
      { id: login.user.id },
      { $set: { mustChangePassword: false } },
    );
    const guard = new AccessGuard(auth);
    expect(
      await guard.canActivate(context('campaigns', 'POST', login.token)),
    ).toBe(true);
    await expect(
      guard.canActivate(context('routing', 'POST', login.token)),
    ).rejects.toThrow('Administrator');
  });
  it('rejects expired and revoked sessions without relying on TTL cleanup', async () => {
    const login = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    await store.updateMany(
      'sessions',
      {},
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(auth.authenticate(login.token)).rejects.toThrow();
    const next = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    await auth.logout(next.token);
    await expect(auth.authenticate(next.token)).rejects.toThrow();
  });
  it('persists sign-in throttling across service instances', async () => {
    for (let i = 0; i < 8; i++)
      await expect(
        auth.login({ username: 'admin', password: 'wrong' }),
      ).rejects.toThrow();
    await expect(
      new AuthService(store).login({
        username: 'admin',
        password: 'Test administrator password 123',
      }),
    ).rejects.toThrow('Too many');
  });
  it('prevents administrator self-disable and attributes audit records', async () => {
    const login = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    await expect(
      auth.saveUser(
        { username: 'admin', name: 'Admin', role: 'viewer', active: true },
        login.user,
      ),
    ).rejects.toThrow();
    await store.asActor(login.user, () =>
      store.audit('Fixture action', 'No external action'),
    );
    expect(
      (await store.one('audit', { action: 'Fixture action' }))?.actorName,
    ).toBe('admin');
  });
  it('never restores the bootstrap password after a password change or restart', async () => {
    const login = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    await auth.changePassword(login.user, {
      currentPassword: 'Test administrator password 123',
      newPassword: 'Changed administrator password 456',
    });
    await expect(auth.authenticate(login.token)).rejects.toThrow();
    await expect(
      auth.login({
        username: 'admin',
        password: 'Test administrator password 123',
      }),
    ).rejects.toThrow('Invalid');
    await new AuthService(store).onModuleInit();
    await expect(
      auth.login({
        username: 'admin',
        password: 'Test administrator password 123',
      }),
    ).rejects.toThrow('Invalid');
    expect(
      (
        await auth.login({
          username: 'admin',
          password: 'Changed administrator password 456',
        })
      ).user.role,
    ).toBe('admin');
  });
  it('requires individual usernames, strong new passwords and explicit route permission', async () => {
    await expect(
      auth.login({ password: 'Test administrator password 123' }),
    ).rejects.toThrow('Invalid');
    const login = await auth.login({
      username: 'admin',
      password: 'Test administrator password 123',
    });
    await expect(
      auth.changePassword(login.user, {
        currentPassword: 'Test administrator password 123',
        newPassword: '123456',
      }),
    ).rejects.toThrow('12');
    const guard = new AccessGuard(auth);
    await expect(
      guard.canActivate(
        context('new-unapproved-operation', 'POST', login.token),
      ),
    ).rejects.toThrow('role');
    await expect(
      guard.canActivate(context('auth/unknown', 'POST', login.token)),
    ).rejects.toThrow('role');
  });
  it.each(['viewer', 'campaign_manager', 'admin'])(
    'enforces the %s permission matrix',
    async (role) => {
      const login = await staff(role);
      await store.update(
        'users',
        { id: login.user.id },
        { $set: { mustChangePassword: false } },
      );
      const guard = new AccessGuard(auth);
      const matrix = [
        ['portal', 'GET', true],
        ['settings', 'GET', true],
        ['auth/password', 'POST', true],
        ['users', 'GET', role === 'admin'],
        ['settings', 'POST', role === 'admin'],
        ['routing', 'POST', role === 'admin'],
        ['operations/provider', 'GET', role === 'admin'],
        ['campaigns', 'POST', role !== 'viewer'],
        ['contacts/import', 'POST', role !== 'viewer'],
        ['operations/crm/example', 'POST', role !== 'viewer'],
        ['sms/test', 'POST', role !== 'viewer'],
      ] as const;
      for (const [path, method, permitted] of matrix) {
        if (permitted)
          expect(
            await guard.canActivate(context(path, method, login.token)),
          ).toBe(true);
        else
          await expect(
            guard.canActivate(context(path, method, login.token)),
          ).rejects.toThrow();
      }
    },
  );
});
