// Where the HCS engine gets its base image (Windows Server Core, ltsc2022). This phase never downloads one: it only
// finds an image that is already on this PC, read-only. The layout of Docker's image store is from memory of Docker's
// windowsfilter graph driver [U]; nothing here writes to it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { HcsImage } from './documents.js';

/** What a store says when it has no image: said to the user in plain words. */
export interface ImageResult {
  readonly image: HcsImage | null;
  readonly reason: string;
}

export interface ImageStore {
  readonly name: string;
  find(): ImageResult;
}

/** The file reads a store does, so tests give it a fake disk. Every read is bounded and a miss is null. */
export interface ImageFiles {
  readText(file: string): string | null;
  isDir(folder: string): boolean;
}

const MAX_TEXT = 4 * 1024 * 1024;

export const REAL_IMAGE_FILES: ImageFiles = {
  readText: (file) => {
    try {
      if (fs.statSync(file).size > MAX_TEXT) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null; // missing or unreadable: the store reports "not found"
    }
  },
  isDir: (folder) => {
    try {
      return fs.statSync(folder).isDirectory();
    } catch {
      return false; // missing: not a folder
    }
  },
};

/** The repository and tag of the image we look for: Windows Server Core 2022, any registry spelling. */
const WANTED = /(^|\/)windows\/servercore:ltsc2022$/i;

const RepositoriesSchema = z.object({ Repositories: z.record(z.string(), z.record(z.string(), z.string())) });
const ImageConfigSchema = z.object({
  rootfs: z.object({
    diff_ids: z
      .array(z.string().regex(/^sha256:[0-9a-f]{64}$/))
      .min(1)
      .max(200),
  }),
});
const HEX64 = /^[0-9a-f]{64}$/;
const CACHE_ID = /^[0-9a-zA-Z]{1,128}$/;

/** Docker's chain ids: id(1) = diffId(1); id(n) = sha256(id(n-1) + " " + diffId(n)). */
export function chainIds(diffIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const diff of diffIds) {
    const prev = out[out.length - 1];
    out.push(
      prev
        ? 'sha256:' +
            crypto
              .createHash('sha256')
              .update(prev + ' ' + diff)
              .digest('hex')
        : diff,
    );
  }
  return out;
}

/** An image Docker Desktop (Windows containers) already pulled: found by reading its metadata, never changed. */
export class DockerImageStore implements ImageStore {
  readonly name = 'an image Docker already pulled';

  constructor(
    private readonly root: string = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'docker'),
    private readonly files: ImageFiles = REAL_IMAGE_FILES,
  ) {}

  find(): ImageResult {
    const meta = path.join(this.root, 'image', 'windowsfilter');
    const repos = this.files.readText(path.join(meta, 'repositories.json'));
    if (repos === null) return { image: null, reason: 'Docker has no Windows images on this PC.' };
    const parsed = RepositoriesSchema.safeParse(safeJson(repos));
    if (!parsed.success) return { image: null, reason: "Docker's image list could not be read." };
    let imageId: string | null = null;
    for (const tags of Object.values(parsed.data.Repositories))
      for (const [name, id] of Object.entries(tags))
        if (!imageId && WANTED.test(name) && /^sha256:[0-9a-f]{64}$/.test(id)) imageId = id;
    if (!imageId) return { image: null, reason: 'Docker has no windows/servercore:ltsc2022 image.' };
    const config = ImageConfigSchema.safeParse(
      safeJson(this.files.readText(path.join(meta, 'imagedb', 'content', 'sha256', imageId.slice(7))) ?? ''),
    );
    if (!config.success) return { image: null, reason: "Docker's record of the Server Core image could not be read." };
    const layers: string[] = [];
    for (const chain of chainIds(config.data.rootfs.diff_ids)) {
      const hex = chain.slice(7);
      if (!HEX64.test(hex)) return { image: null, reason: 'A layer id of the Server Core image is not valid.' };
      const cacheId = (this.files.readText(path.join(meta, 'layerdb', 'sha256', hex, 'cache-id')) ?? '').trim();
      if (!CACHE_ID.test(cacheId)) return { image: null, reason: 'A layer of the Server Core image is not on disk.' };
      const folder = path.join(this.root, 'windowsfilter', cacheId);
      if (!this.files.isDir(folder)) return { image: null, reason: 'A layer of the Server Core image is missing.' };
      layers.push(folder);
    }
    const utilityVmFiles = path.join(layers[0], 'UtilityVM', 'Files');
    if (!this.files.isDir(utilityVmFiles))
      return { image: null, reason: 'The Server Core image has no UtilityVM folder (Hyper-V isolation needs it).' };
    return { image: { id: imageId, layers, utilityVmFiles }, reason: '' };
  }
}

const FolderImageSchema = z.object({
  layers: z.array(z.string().min(3).max(260)).min(1).max(200),
  utilityVmFiles: z.string().min(3).max(260),
});

/** Your own image folder (AGENT_SANDBOX_HCS_IMAGE): a folder with image.json {layers (base first), utilityVmFiles}. */
export class FolderImageStore implements ImageStore {
  readonly name = 'an image folder you named';

  constructor(
    private readonly folder: string | undefined = process.env.AGENT_SANDBOX_HCS_IMAGE,
    private readonly files: ImageFiles = REAL_IMAGE_FILES,
  ) {}

  find(): ImageResult {
    if (!this.folder) return { image: null, reason: 'No image folder is set (AGENT_SANDBOX_HCS_IMAGE).' };
    const parsed = FolderImageSchema.safeParse(
      safeJson(this.files.readText(path.join(this.folder, 'image.json')) ?? ''),
    );
    if (!parsed.success) return { image: null, reason: 'There is no valid image.json in ' + this.folder + '.' };
    const all = [...parsed.data.layers, parsed.data.utilityVmFiles];
    if (!all.every((p) => path.isAbsolute(p) && this.files.isDir(p)))
      return { image: null, reason: 'A folder named in ' + path.join(this.folder, 'image.json') + ' is missing.' };
    return {
      image: { id: 'folder', layers: parsed.data.layers, utilityVmFiles: parsed.data.utilityVmFiles },
      reason: '',
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON: the schema check then fails with a plain message
  }
}

export function defaultImageStores(): ImageStore[] {
  return [new FolderImageStore(), new DockerImageStore()];
}

/** The first image any store has, or every store's reason. */
export function findImage(stores: readonly ImageStore[]): ImageResult {
  const reasons: string[] = [];
  for (const store of stores) {
    const result = store.find();
    if (result.image) return result;
    reasons.push(result.reason);
  }
  return { image: null, reason: reasons.join(' ') };
}
