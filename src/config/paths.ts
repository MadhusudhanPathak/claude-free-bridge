import * as os from 'os';
import * as path from 'path';

export const CONFIG_DIR = path.join(os.homedir(), '.claude-free-bridge');
export const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
export const PROFILES_ROOT = path.join(CONFIG_DIR, 'profiles');
export const KNOWN_ORGS_PATH = path.join(CONFIG_DIR, 'known_orgs.json');
export const DB_JSON_PATH = path.join(CONFIG_DIR, 'db.json');
export const LOG_PATH = path.join(CONFIG_DIR, 'bridge.log');
