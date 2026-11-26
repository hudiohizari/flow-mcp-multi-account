#!/usr/bin/env node
import { runLoginCli } from "./login-cli.js";

try {
  await runLoginCli(process.argv.slice(2));
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
