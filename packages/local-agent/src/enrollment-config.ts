export interface EnrollmentConfig {
  url: string;
  token: string;
  ownerId: string;
  displayName?: string;
}

export interface ResolvedEnrollmentConfig {
  rotateKey: boolean;
  enrollment?: EnrollmentConfig;
}

export function resolveEnrollmentConfig(env: NodeJS.ProcessEnv): ResolvedEnrollmentConfig {
  const rotateKey = env.AGENT_ROTATE_KEY === '1';
  const url = env.AGENT_ENROLLMENT_URL;
  const token = env.AGENT_ENROLLMENT_TOKEN;
  const ownerId = env.AGENT_OWNER_ID;
  const hasEnrollmentValue = Boolean(url || token || ownerId);

  if (hasEnrollmentValue && (!url || !token || !ownerId)) {
    throw new Error('AGENT_ENROLLMENT_URL, AGENT_ENROLLMENT_TOKEN, and AGENT_OWNER_ID must be configured together.');
  }
  if (rotateKey && !hasEnrollmentValue) {
    throw new Error('AGENT_ROTATE_KEY=1 requires complete enrollment configuration so the rotated public key can be registered.');
  }

  return {
    rotateKey,
    ...(url && token && ownerId ? {
      enrollment: {
        url,
        token,
        ownerId,
        ...(env.AGENT_DISPLAY_NAME ? { displayName: env.AGENT_DISPLAY_NAME } : {}),
      },
    } : {}),
  };
}
