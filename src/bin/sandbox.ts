#!/usr/bin/env node
// sandbox / windows-development-sandbox: the menu with no arguments, any command, or `sandbox <agent>`.
import { run } from '../cli/index.js';

run(process.argv.slice(2));
