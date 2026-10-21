import { BridgeFailure } from '../../../shared/src/errors';
import type { AccountInfo, OrgInfo } from '../../../shared/src/protocol';
import { json } from './http';

interface RawOrg {
  uuid: string;
  name?: string;
  capabilities?: string[];
}

function planOf(caps: string[]): string {
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('raven')) return 'Team/Enterprise';
  if (caps.includes('claude_pro')) return 'Pro';
  return 'Free';
}

/** The logged-in account and its chat organizations; `orgHint` picks the current one. */
export async function getAccount(orgHint?: string): Promise<AccountInfo> {
  const raw = await json<RawOrg[]>('/organizations');
  if (!Array.isArray(raw) || !raw.length) throw new BridgeFailure('UPSTREAM_ERROR', 'claude.ai returned no organizations');
  const chatOrgs = raw.filter((o) => o.capabilities?.includes('chat'));
  const orgs: OrgInfo[] = (chatOrgs.length ? chatOrgs : raw).map((o) => ({
    id: o.uuid,
    name: o.name || 'Personal',
    plan: planOf(o.capabilities ?? []),
  }));
  const org = orgs.find((o) => o.id === orgHint) ?? orgs[0];

  let email: string | null = null;
  let name: string | null = null;
  try {
    const acct = await json<{ email_address?: string; full_name?: string; display_name?: string }>('/account');
    email = acct?.email_address ?? null;
    name = acct?.display_name || acct?.full_name || null;
  } catch (e) {
    if (e instanceof BridgeFailure && e.code === 'AUTH_INVALID') throw e;
    // The email is nice to have; carry on without it.
  }
  return { email, name, org, orgs };
}

/** The org to use when the service worker didn't pass one. */
export async function resolveOrg(orgId: string): Promise<string> {
  if (orgId) return orgId;
  return (await getAccount()).org.id;
}
