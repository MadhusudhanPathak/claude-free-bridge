import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type BrowserLaunchKind = 'channel' | 'executablePath' | 'bundled';

export interface DetectedBrowser {
  id: string;
  label: string;
  kind: BrowserLaunchKind;
  value?: string; // channel name or executable path, depending on kind
}

interface Candidate {
  id: string;
  label: string;
  kind: BrowserLaunchKind;
  value?: string;
  paths: string[];
}

function candidatesForPlatform(): Candidate[] {
  const home = os.homedir();
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');

  if (process.platform === 'win32') {
    return [
      {
        id: 'chrome', label: 'Google Chrome', kind: 'channel', value: 'chrome',
        paths: [
          path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
      },
      {
        id: 'msedge', label: 'Microsoft Edge', kind: 'channel', value: 'msedge',
        paths: [
          path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
      },
      {
        id: 'brave', label: 'Brave', kind: 'executablePath',
        paths: [
          path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ],
      },
      {
        id: 'firefox', label: 'Firefox (limited automation support — may fall back to Playwright\'s bundled Firefox)', kind: 'executablePath',
        paths: [
          path.join(pf, 'Mozilla Firefox', 'firefox.exe'),
          path.join(pf86, 'Mozilla Firefox', 'firefox.exe'),
        ],
      },
      {
        id: 'opera', label: 'Opera', kind: 'executablePath',
        paths: [
          path.join(local, 'Programs', 'Opera', 'opera.exe'),
          path.join(local, 'Programs', 'Opera', 'launcher.exe'),
        ],
      },
    ];
  }

  if (process.platform === 'darwin') {
    return [
      { id: 'chrome', label: 'Google Chrome', kind: 'channel', value: 'chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      { id: 'msedge', label: 'Microsoft Edge', kind: 'channel', value: 'msedge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { id: 'brave', label: 'Brave', kind: 'executablePath', paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
      { id: 'firefox', label: 'Firefox (limited automation support)', kind: 'executablePath', paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    ];
  }

  // Linux and others
  return [
    { id: 'chrome', label: 'Google Chrome', kind: 'channel', value: 'chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] },
    { id: 'msedge', label: 'Microsoft Edge', kind: 'channel', value: 'msedge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { id: 'brave', label: 'Brave', kind: 'executablePath', paths: ['/usr/bin/brave-browser'] },
    { id: 'firefox', label: 'Firefox (limited automation support)', kind: 'executablePath', paths: ['/usr/bin/firefox'] },
  ];
}

/**
 * Detect real, installed browsers on this machine by checking their standard install
 * locations. Only browsers that are actually found are returned, plus a "bundled" fallback
 * (Playwright's own automation-patched Chromium) that is always available.
 *
 * Driving a real installed browser (Chrome/Edge/Brave) presents a normal browser fingerprint
 * and is far less likely to trip claude.ai's bot-detection challenge than the bundled build.
 */
export function detectInstalledBrowsers(): DetectedBrowser[] {
  const found: DetectedBrowser[] = [];
  for (const c of candidatesForPlatform()) {
    const foundPath = c.paths.find((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (foundPath) {
      found.push({ id: c.id, label: c.label, kind: c.kind, value: c.kind === 'executablePath' ? foundPath : c.value });
    }
  }
  found.push({ id: 'bundled', label: 'Automated Chromium (bundled with Playwright — most likely to be challenged)', kind: 'bundled' });
  return found;
}

export function getBrowserById(id: string): DetectedBrowser | undefined {
  return detectInstalledBrowsers().find((b) => b.id === id);
}
