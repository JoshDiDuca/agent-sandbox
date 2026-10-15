// The app's files from dist/web: nothing outside that folder is ever read, and links in it are not followed.
import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from '../../shared/paths/index.js';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticFile {
  readonly file: string;
  readonly type: string;
  /** Hashed asset names never change, so browsers may keep them. */
  readonly immutable: boolean;
}

export class StaticFiles {
  constructor(private readonly root: string) {}

  /** The file for a URL path, or null when it is not a file inside the root. Extension-less paths are the app. */
  find(urlPath: string): StaticFile | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
    const rel = decoded === '/' ? '/index.html' : decoded;
    const file = this.regular(rel);
    if (file) return file;
    // The app has its own pages (client side): anything that is not a file name is the app.
    return path.extname(rel) === '' ? this.regular('/index.html') : null;
  }

  private regular(rel: string): StaticFile | null {
    const file = path.resolve(this.root, '.' + rel);
    if (!isWithin(this.root, file) || file === path.resolve(this.root)) return null;
    try {
      if (!fs.lstatSync(file).isFile()) return null;
    } catch {
      return null;
    }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return null;
    return { file, type, immutable: /-[A-Z0-9]{8}\.(js|css|woff2?)$/.test(path.basename(file)) };
  }
}
