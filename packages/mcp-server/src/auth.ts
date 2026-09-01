import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { ExecutionProfile } from '@terminal/protocol';
import type { ServerConfig } from './config.js';

export function createTokenVerifier(config: ServerConfig): OAuthTokenVerifier {
  if (config.authMode === 'development') {
    if (!config.developmentToken) throw new Error('MCP_DEVELOPMENT_TOKEN is required for development authentication.');
    return new DevelopmentTokenVerifier(
      config.developmentToken,
      config.developmentUserId,
      config.publicUrl,
      config.requiredScopes,
      config.defaultExecutionProfile,
    );
  }

  if (!config.oauthIssuer || !config.oauthJwksUrl || !config.oauthAudience) {
    throw new Error('JWT authentication is missing issuer, JWKS URL, or audience configuration.');
  }
  return new JwtTokenVerifier(
    config.oauthIssuer,
    config.oauthJwksUrl,
    config.oauthAudience,
    config.publicUrl,
    config.defaultExecutionProfile,
    config.oauthUserIdClaim,
    config.authMode,
  );
}

class DevelopmentTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly expectedToken: string,
    private readonly userId: string,
    private readonly resource: URL,
    private readonly scopes: string[],
    private readonly executionProfile: ExecutionProfile,
  ) {}

  verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!timingSafeEqualText(token, this.expectedToken)) return Promise.reject(invalidToken());
    return Promise.resolve({
      token,
      clientId: 'local-development-client',
      scopes: [...this.scopes],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: this.resource,
      extra: {
        user_id: this.userId,
        auth_mode: 'development',
        execution_profile: this.executionProfile,
      },
    });
  }
}

class JwtTokenVerifier implements OAuthTokenVerifier {
  private readonly jwks;

  constructor(
    private readonly issuer: URL,
    jwksUrl: URL,
    private readonly audience: string,
    private readonly resource: URL,
    private readonly defaultExecutionProfile: ExecutionProfile,
    private readonly userIdClaim: 'sub' | 'email',
    private readonly authMode: 'jwt' | 'cloudflare-access',
  ) {
    this.jwks = createRemoteJWKSet(jwksUrl);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer.href.replace(/\/$/, ''),
        audience: this.audience,
      });
      if (!payload.exp) throw invalidToken('Access token is missing required exp claim.');
      const userId = this.userIdClaim === 'sub' ? payload.sub : stringClaim(payload, this.userIdClaim);
      if (!userId) throw invalidToken(`Access token is missing required ${this.userIdClaim} claim.`);
      return {
        token,
        clientId: stringClaim(payload, 'client_id') ?? stringClaim(payload, 'azp') ?? (this.authMode === 'cloudflare-access' ? 'cloudflare-managed-oauth' : 'unknown-client'),
        scopes: scopesFromPayload(payload),
        expiresAt: payload.exp,
        resource: this.resource,
        extra: {
          user_id: userId,
          issuer: payload.iss,
          auth_mode: this.authMode,
          execution_profile: executionProfileClaim(payload) ?? this.defaultExecutionProfile,
          ...(stringClaim(payload, 'chatgpt_session_id') ? { chatgpt_session_id: stringClaim(payload, 'chatgpt_session_id') } : {}),
        },
      };
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw invalidToken('Access token validation failed.');
    }
  }
}

export function createOAuthMetadata(config: ServerConfig): OAuthMetadata | undefined {
  if (config.authMode === 'cloudflare-access') return undefined;
  if (!config.oauthIssuer || !config.oauthAuthorizationEndpoint || !config.oauthTokenEndpoint) return undefined;
  return {
    issuer: config.oauthIssuer.href.replace(/\/$/, ''),
    authorization_endpoint: config.oauthAuthorizationEndpoint.href,
    token_endpoint: config.oauthTokenEndpoint.href,
    ...(config.oauthRegistrationEndpoint ? { registration_endpoint: config.oauthRegistrationEndpoint.href } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: config.advertisedScopes,
  };
}

function scopesFromPayload(payload: JWTPayload): string[] {
  const scope = stringClaim(payload, 'scope');
  if (scope) return scope.split(/\s+/).filter(Boolean);
  const scp = payload.scp;
  if (Array.isArray(scp)) return scp.filter((value): value is string => typeof value === 'string');
  if (typeof scp === 'string') return scp.split(/\s+/).filter(Boolean);
  return [];
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function executionProfileClaim(payload: JWTPayload): ExecutionProfile | undefined {
  const value = stringClaim(payload, 'execution_profile');
  return value === 'read-only' || value === 'developer' || value === 'owner-full' ? value : undefined;
}

function invalidToken(message = 'Invalid access token.'): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
