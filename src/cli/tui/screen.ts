import { type FrameParts } from './frame.js';
import { type Key } from './terminal.js';

export interface Size {
  width: number;
  height: number;
}
/** What a screen's key handler returns: `{ done: value }` ends the screen, nothing keeps it open (and redraws it). */
export type Step<T> = { done: T } | undefined | void;

export interface Screen<T> {
  render(size: Size): FrameParts;
  handle(key: Key): Step<T> | Promise<Step<T>>;
}
