import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const repository = path.resolve(import.meta.dirname, "..");

test("app entrypoint terminates su option parsing before forwarding a Node option", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orbitflow-entrypoint-"));
  const bin = path.join(sandbox, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "mkdir"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(path.join(bin, "su"), `#!/bin/sh
set -eu
[ "$1" = "-s" ] && [ "$2" = "/bin/sh" ] && [ "$3" = "-c" ]
[ "$4" = 'exec "$@"' ] && [ "$5" = "--" ] && [ "$6" = "node" ]
[ "$7" = "orbitflow-app-entrypoint" ]
shift 7
exec "$@"
`, "utf8");
  await Promise.all(["mkdir", "chown", "su"].map((name) => chmod(path.join(bin, name), 0o755)));

  const result = spawnSync("sh", ["docker/app-entrypoint.sh", "node", "--experimental-strip-types", "-e", "process.stdout.write('forwarded')"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "forwarded");
});

test("Telegram remains an opt-in profile with the option-bearing Node command", async () => {
  const compose = await readFile(path.join(repository, "compose.yaml"), "utf8");
  assert.match(compose, /telegram:\n    profiles: \["telegram"\]/);
  assert.match(compose, /command: \["node", "--experimental-strip-types", "src\/runtime\/telegram\.ts"\]/);
});

test("Telegram runtime fails closed on a blank token before it reaches the database or provider", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/runtime/telegram.ts"], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://not-used-before-token-guard@127.0.0.1:1/orbitflow",
      TELEGRAM_BOT_TOKEN: "   ",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /TELEGRAM_BOT_TOKEN is required/);
  assert.doesNotMatch(output, /not-used-before-token-guard/);
});
