// What a storage provider hands the launch: the data set (tools, state, logs, channel) as folders to share into the
// sandbox, or as disks to attach.
import type { ResolvedMapping } from '../../../core/types.js';

/** `folder`: a host folder shared in (it is also one of the plan's mappings). `disk`: an image the engine attaches. */
export type StorageAttachment =
  | { readonly kind: 'folder'; readonly host: string; readonly guest: string; readonly readOnly: boolean }
  | { readonly kind: 'disk'; readonly image: string; readonly guest: string; readonly maxGb: number };

export interface DataSet {
  readonly dataPath: string;
  readonly guest: string;
}

export interface PreparedStorage {
  readonly attachments: readonly StorageAttachment[];
  /** The folder attachments as mappings, in the order they go in the launch. */
  readonly mappings: readonly ResolvedMapping[];
}

export interface ProviderCheck {
  readonly available: boolean;
  readonly reasons: readonly string[];
  readonly fixes: readonly string[];
}

export interface StorageProvider {
  readonly id: 'folder' | 'vhdx-mounted' | 'vhdx-attached';
  check(): Promise<ProviderCheck>;
  prepare(dataSet: DataSet): Promise<PreparedStorage>;
  release(): Promise<void>;
}
