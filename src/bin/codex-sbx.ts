#!/usr/bin/env node
import { run } from '../cli/index.js';

run(process.argv.slice(2), { harness: 'codex' });
