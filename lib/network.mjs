import os from 'node:os';
import net from 'node:net';

export function localAddresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(Boolean).filter((entry) => {
    if (entry.internal) return false;
    const ip = entry.address;
    if (net.isIP(ip) === 6) return /^f[cd][0-9a-f]{2}:/i.test(ip);
    if (net.isIP(ip) !== 4) return false;
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }).map((entry) => entry.address))];
}

export const urlHost = (host) => net.isIP(host) === 6 ? `[${host}]` : host;
