#!/usr/bin/env node
import { run } from '../cli/index.js';

const args = process.argv.slice(2);
const personal = args.includes('--personal') ? ['--personal'] : [];
run(['host-claude', ...personal, '--', ...args.filter((a) => a !== '--personal')]);
