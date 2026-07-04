// HTTP API Lambda authorizer (IAM response). Validates the caller's FreeLLMAPI
// key by probing GET {NLB}/v1/models — Allow iff the upstream returns 200.
// Fail-closed: any non-200, timeout, or error => Deny.
const NLB_ENDPOINT = process.env.FREELLMAPI_INTERNAL_URL;

export const handler = async (event) => {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const token = extractBearerToken(header);
  if (!token) return generatePolicy('anonymous', 'Deny', event.routeArn);

  try {
    const res = await fetch(`${NLB_ENDPOINT}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return generatePolicy(token, res.ok ? 'Allow' : 'Deny', event.routeArn);
  } catch (err) {
    console.error('authz probe failed:', err.message);
    return generatePolicy(token, 'Deny', event.routeArn);
  }
};

export function extractBearerToken(header) {
  if (!header) return null;
  const parts = header.split(' ');
  return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
}

export function generatePolicy(principalId, effect, resourceArn) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resourceArn }],
    },
    context: { tokenValidated: String(effect === 'Allow') },
  };
}
