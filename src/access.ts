import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { CampaignStore } from './campaign.store';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const path = String(req.path)
      .replace(/^\/api\/?/, '')
      .replace(/^\//, '');
    if (
      !path ||
      path === 'health' ||
      path === 'public/config' ||
      /^(tracking|unsubscribe)\//.test(path) ||
      path.startsWith('webhooks/')
    )
      return true;
    const key = String(req.headers['x-portal-key'] || ''),
      expected = process.env.PORTAL_API_KEY || '';
    if (
      expected.length < 32 ||
      Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new UnauthorizedException('Valid API credentials are required.');
    if (path.startsWith('worker/')) {
      req.portalActor = {
        id: 'chrome-worker',
        username: 'chrome-worker',
        role: 'system',
      };
      return true;
    }
    if (path === 'auth/login') return true;
    const token = String(req.headers.authorization || '').replace(
      /^Bearer /,
      '',
    );
    const user = await this.auth.authenticate(token);
    req.portalActor = user;
    req.portalToken = token;
    if (
      user.mustChangePassword &&
      !['auth/me', 'auth/logout', 'auth/password'].includes(path)
    )
      throw new ForbiddenException(
        'Change your temporary password before using the workspace.',
      );
    if (
      (path === 'users' ||
        path.startsWith('users/') ||
        path === 'operations/provider' ||
        (path === 'settings' && req.method !== 'GET') ||
        (path === 'routing' && req.method !== 'GET')) &&
      user.role !== 'admin'
    )
      throw new ForbiddenException('Administrator access required.');
    if (
      req.method !== 'GET' &&
      !path.startsWith('auth/') &&
      user.role === 'viewer'
    )
      throw new ForbiddenException('Your account has read-only access.');
    return true;
  }
}

@Injectable()
export class ActorInterceptor implements NestInterceptor {
  constructor(private readonly store: CampaignStore) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const actor = context.switchToHttp().getRequest().portalActor || {
      id: 'public',
      username: 'public-webhook',
      role: 'system',
    };
    return new Observable((subscriber) =>
      this.store.asActor(actor, () => next.handle().subscribe(subscriber)),
    );
  }
}
