import { describe, it, expect } from 'vitest';
import { parseUserAgent } from '../src/ua';

describe('parseUserAgent', () => {
  it('reports unknown for Gmail proxy fetches rather than guessing', () => {
    const ua = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 '
      + '(via ggpht.com GoogleImageProxy)';
    expect(parseUserAgent(ua)).toEqual({
      deviceClass: 'unknown', os: null, client: 'Gmail (proxied)',
    });
  });

  it('reports unknown for an empty User-Agent', () => {
    expect(parseUserAgent('')).toEqual({
      deviceClass: 'unknown', os: null, client: null,
    });
  });

  it('identifies iPhone as mobile running iOS', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('mobile');
    expect(info.os).toBe('iOS');
  });

  it('identifies iPad as a tablet', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(parseUserAgent(ua).deviceClass).toBe('tablet');
  });

  it('distinguishes Android phone from Android tablet by the Mobile token', () => {
    const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
    const tablet = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    expect(parseUserAgent(phone).deviceClass).toBe('mobile');
    expect(parseUserAgent(tablet).deviceClass).toBe('tablet');
  });

  it('identifies Outlook desktop', () => {
    const ua = 'Microsoft Outlook 16.0 (Windows NT 10.0)';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('desktop');
    expect(info.client).toBe('Outlook');
    expect(info.os).toBe('Windows');
  });

  it('identifies macOS Apple Mail by an AppleWebKit UA with no Version token', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const info = parseUserAgent(ua);
    expect(info.deviceClass).toBe('desktop');
    expect(info.os).toBe('macOS');
    expect(info.client).toBe('Apple Mail');
  });

  it('does not label desktop Safari as Apple Mail', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(parseUserAgent(ua).client).toBeNull();
  });
});
