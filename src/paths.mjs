import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.join(projectRoot, 'data');
export const databasePath = path.join(dataDir, 'library.sqlite');
export const publicDir = path.join(projectRoot, 'public');
export const sourcesPath = path.join(projectRoot, 'config', 'sources.json');
