// What the background watcher marks, and the size of the persisted data: host-only files next to the sync state.
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile } from '../storage/index.js';

const MarkedSchema = z.array(z.string().max(1024)).max(64);
const DataSizeSchema = z.object({ bytes: z.number().min(0), at: z.string().max(40) });
type DataSize = z.output<typeof DataSizeSchema>;

function marksFile(storageRoot: string, dataPath: string): JsonFile<string[]> {
  return new JsonFile(MarkedSchema, hostStateFile(storageRoot, dataPath, '-mark.json'));
}
function sizeFile(storageRoot: string, dataPath: string): JsonFile<DataSize> {
  return new JsonFile(DataSizeSchema, hostStateFile(storageRoot, dataPath, '-size.json'));
}

/** The projects to watch and mark (empty: storage.markSandboxFiles is off). */
export function saveMarkedProjects(storageRoot: string, dataPath: string, projects: string[]): void {
  marksFile(storageRoot, dataPath).write(projects);
}
export function readMarkedProjects(storageRoot: string, dataPath: string): string[] {
  return marksFile(storageRoot, dataPath).read() ?? [];
}

/** The data folder's size, measured by the watcher when a sandbox closes (measuring at launch would be slow). */
export function saveDataSize(storageRoot: string, dataPath: string, bytes: number): void {
  sizeFile(storageRoot, dataPath).write({ bytes, at: new Date().toISOString() });
}
export function readDataSize(storageRoot: string, dataPath: string): { bytes: number; at: string } | null {
  return sizeFile(storageRoot, dataPath).read();
}
