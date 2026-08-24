export type DeviceClass = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface DeviceInfo {
  readonly deviceClass: DeviceClass;
  readonly os: string | null;
  readonly client: string | null;
}

const UNKNOWN: DeviceInfo = { deviceClass: 'unknown', os: null, client: null };

/**
 * Apple Mail presents an AppleWebKit UA carrying neither a Version/ nor a
 * Safari/ token; real Safari always carries both.
 */
function appleMailClient(ua: string): string | null {
  const isWebKit = ua.includes('AppleWebKit');
  const isBrowser = ua.includes('Version/') || ua.includes('Safari/');
  return isWebKit && !isBrowser ? 'Apple Mail' : null;
}

export function parseUserAgent(ua: string): DeviceInfo {
  if (!ua) return UNKNOWN;

  // Gmail proxies every image fetch. There is no device signal to recover;
  // reporting "unknown" honestly beats guessing. See spec 5.7 / L2.
  if (ua.includes('GoogleImageProxy')) {
    return { deviceClass: 'unknown', os: null, client: 'Gmail (proxied)' };
  }

  if (ua.includes('Microsoft Outlook')) {
    return {
      deviceClass: 'desktop',
      os: ua.includes('Macintosh') ? 'macOS' : 'Windows',
      client: 'Outlook',
    };
  }

  if (/iPhone|iPod/.test(ua)) {
    return { deviceClass: 'mobile', os: 'iOS', client: appleMailClient(ua) };
  }

  if (ua.includes('iPad')) {
    return { deviceClass: 'tablet', os: 'iPadOS', client: appleMailClient(ua) };
  }

  if (ua.includes('Android')) {
    return {
      deviceClass: ua.includes('Mobile') ? 'mobile' : 'tablet',
      os: 'Android',
      client: null,
    };
  }

  if (/Macintosh|Mac OS X/.test(ua)) {
    return { deviceClass: 'desktop', os: 'macOS', client: appleMailClient(ua) };
  }

  if (ua.includes('Windows NT')) {
    return { deviceClass: 'desktop', os: 'Windows', client: null };
  }

  if (ua.includes('Linux')) {
    return { deviceClass: 'desktop', os: 'Linux', client: null };
  }

  return UNKNOWN;
}
