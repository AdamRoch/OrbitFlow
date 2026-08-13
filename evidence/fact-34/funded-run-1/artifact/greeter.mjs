#!/usr/bin/env node

// Dependency-free greeting CLI (first pass).
// Usage: node greeter.mjs --name <value>

function parseArgs(argv) {
  const args = argv.slice(2);
  let name;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name') {
      if (i + 1 >= args.length) {
        return { error: 'Option --name requires a value.' };
      }
      name = args[++i];
    } else {
      return { error: `Unknown option: ${arg}` };
    }
  }

  if (name === undefined) {
    return { error: 'Missing required option: --name <value>.' };
  }

  const trimmed = name.trim();
  if (trimmed === '') {
    return { error: 'The --name value must not be empty.' };
  }

  return { name: trimmed };
}

const { name, error } = parseArgs(process.argv);

if (error) {
  process.stderr.write(`Error: ${error}\n`);
  process.exit(2);
}

process.stdout.write(`Hello, ${name}!\n`);
