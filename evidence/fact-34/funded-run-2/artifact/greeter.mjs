#!/usr/bin/env node
// greeter.mjs - dependency-free CLI that greets a person by name.

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write('Usage: node greeter.mjs --name <name>\n');
  process.exit(2);
}

function parseArgs(argv) {
  let name;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('Option --name requires a value.');
      }
      name = value;
      i++;
    } else if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }
  return name;
}

const name = parseArgs(process.argv.slice(2));

if (name === undefined) {
  fail('Missing required option: --name <name>.');
}

const trimmed = name.trim();
if (trimmed === '') {
  fail('The --name value must not be empty.');
}

process.stdout.write(`Hello, ${trimmed}!\n`);
