import { describe, expect, it } from 'vitest';
import { chromeIntentUrl, classifyUserAgent, type UaInfo } from '../src/platform/detect';

const UA = {
  googleAppAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-X710 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Safari/537.36 GSA/15.40.32.29.arm64',
  googleAppIpad: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/385.0.795037212 Mobile/15E148 Safari/604.1',
  chromeAndroidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  webView: 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
  ipadDesktopSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  crios: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  fxios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]',
  instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
  wkWebView: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  firefoxDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
};

describe('classifyUserAgent', () => {
  const cases: [string, string, number, Partial<UaInfo>][] = [
    ['Google app on an Android tablet', UA.googleAppAndroid, 5, { os: 'android', browser: 'chrome', host: 'google-app' }],
    ['Google app on iPad', UA.googleAppIpad, 5, { os: 'ios', host: 'google-app' }],
    ['Chrome on an Android tablet', UA.chromeAndroidTablet, 5, { os: 'android', browser: 'chrome', host: null }],
    ['an Android WebView', UA.webView, 5, { os: 'android', host: 'android-webview' }],
    ['iPadOS Safari asking for desktop sites', UA.ipadDesktopSafari, 5, { os: 'ios', browser: 'safari', host: null }],
    ['Safari on a Mac', UA.ipadDesktopSafari, 0, { os: 'desktop', browser: 'safari', host: null }],
    ['Chrome on iOS', UA.crios, 5, { os: 'ios', browser: 'chrome', host: null }],
    ['Firefox on iOS', UA.fxios, 5, { os: 'ios', browser: 'firefox', host: null }],
    ['Edge on Android', UA.edgeAndroid, 5, { browser: 'edge', host: null }],
    ['Samsung Internet', UA.samsung, 5, { browser: 'samsung', host: null }],
    ['Facebook on iOS', UA.facebookIos, 5, { host: 'facebook' }],
    ['Instagram', UA.instagram, 5, { host: 'instagram' }],
    ['an iOS app web view', UA.wkWebView, 5, { os: 'ios', host: 'other-in-app' }],
    ['Firefox on a desktop', UA.firefoxDesktop, 0, { os: 'desktop', browser: 'firefox', host: null }],
  ];
  it.each(cases)('%s', (_name, ua, touchPoints, expected) => {
    expect(classifyUserAgent(ua, touchPoints)).toMatchObject(expected);
  });
});

describe('chromeIntentUrl', () => {
  it('opens the same page in Chrome, falling back to the page itself', () => {
    expect(chromeIntentUrl('https://dhiviyadev.github.io/Mobile_apps/?open=arena')).toBe(
      'intent://dhiviyadev.github.io/Mobile_apps/?open=arena#Intent;scheme=https;package=com.android.chrome;' +
        'S.browser_fallback_url=https%3A%2F%2Fdhiviyadev.github.io%2FMobile_apps%2F%3Fopen%3Darena;end',
    );
  });
});
