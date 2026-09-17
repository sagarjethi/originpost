import { BlockList, isIP } from 'node:net';

export function adminNetworkAllowed(setting: string | undefined, address: string): boolean {
  if (!setting?.trim()) return true;
  const list = new BlockList();
  for (const entry of setting.split(',').map(x => x.trim())) {
    const [ip,prefix,...extra] = entry.split('/');
    const family = isIP(ip ?? '');
    if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) throw new Error('ADMIN_ALLOWED_IPS must contain valid comma-separated IP addresses or CIDR networks.');
    if (prefix === undefined) list.addAddress(ip!,family === 4 ? 'ipv4' : 'ipv6');
    else list.addSubnet(ip!,Number(prefix),family === 4 ? 'ipv4' : 'ipv6');
  }
  const normalized=address.startsWith('::ffff:') ? address.slice(7) : address;
  const family=isIP(normalized);
  return Boolean(family && list.check(normalized,family === 4 ? 'ipv4' : 'ipv6'));
}
export function isCredentialMutation(method: string,url: string): boolean {
  return !['GET','HEAD','OPTIONS'].includes(method.toUpperCase()) && /^\/v1\/(?:agent-runtimes|channels|audio\/profiles)(?:\/|\?|$)/.test(url);
}
