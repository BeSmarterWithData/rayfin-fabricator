import {
  ensureSignedInWithFabric,
  initEmbeddedAuth as sdkInitEmbeddedAuth,
  signInWithBrokeredToken,
  type FabricAuthOptions,
} from '@microsoft/rayfin-auth-provider-fabric';
import type { RayfinClient } from '@microsoft/rayfin-client';

import type { UniversalAppSchema } from '../../rayfin/data/schema';

import { type AuthUser, type IAuthService, toAuthUser } from './IAuthService';

/**
 * Production auth service. Wraps the Fabric brokered authentication SDK
 * (`@microsoft/rayfin-auth-provider-fabric`).
 *
 * Used whenever the API URL is not localhost. Requires Fabric workspace,
 * project, and portal config to be passed at construction time — see
 * `bootstrapAuth()` for how those are read from VITE_FABRIC_* env vars.
 */
export class RayfinAuthService implements IAuthService {
  readonly fabricAuthEnabled = true;

  constructor(
    private readonly client: RayfinClient<UniversalAppSchema>,
    private readonly fabricOptions: FabricAuthOptions
  ) {}

  async signIn(): Promise<AuthUser> {
    const session = await ensureSignedInWithFabric(
      this.client.auth,
      this.fabricOptions
    );
    if (!session.isAuthenticated || !session.user) {
      throw new Error(
        'Fabric authentication completed but no session was established.'
      );
    }
    return toAuthUser(session.user);
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    const session = this.client.auth.getSession();
    if (!session.isAuthenticated || !session.user) return null;
    return toAuthUser(session.user);
  }

  async initEmbeddedAuth(): Promise<AuthUser | null> {
    const session = await sdkInitEmbeddedAuth(
      this.client.auth,
      this.fabricOptions
    );
    if (!session?.isAuthenticated || !session.user) return null;
    return toAuthUser(session.user);
  }

  async initLocalDevAuth(): Promise<AuthUser | null> {
    // The DEV guard plus the dynamic import keep this package, and its local
    // sign-in endpoint, out of production builds.
    if (import.meta.env.DEV) {
      const localDev = await import('@microsoft/rayfin-local-dev');
      if (localDev.isRayfinLocalAutoLoginEnabled()) {
        // The dev server exchanged your Rayfin CLI sign-in for a Rayfin
        // session; the Entra token itself never reaches the browser.
        const token = await localDev.fetchRayfinLocalSessionToken();
        if (token) {
          const session = await signInWithBrokeredToken(
            this.client.auth,
            token
          );
          if (session.isAuthenticated && session.user) {
            return toAuthUser(session.user);
          }
        }
      }
    }
    return null;
  }
}
