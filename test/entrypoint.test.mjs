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

test("Telegram Compose proof renders each credential case from an isolated interpolation file", async () => {
  const proof = await readFile(path.join(repository, "scripts/fact-32-telegram-compose-proof.sh"), "utf8");
  assert.match(proof, /write_env_file "\$missing_token_env_file" ""/);
  assert.match(proof, /write_env_file "\$invalid_token_env_file" "fact32-invalid-token"/);
  assert.match(proof, /compose_with_env "\$missing_token_env_file" run --rm --no-deps telegram/);
  assert.match(proof, /compose_with_env "\$invalid_token_env_file" run --rm --no-deps telegram/);
  assert.doesNotMatch(proof, /-e TELEGRAM_BOT_TOKEN=/);
});

test("Telegram Compose proof diagnostics classify failures and redact every controlled credential", () => {
  const sample = [
    "TELEGRAM_BOT_TOKEN=fact32-present-token",
    "OPENROUTER_API_KEY=not-a-real-key-for-fact32-proof",
    "POSTGRES_PASSWORD=fact32-local-password",
    "postgresql://orbitflow:fact32-local-password@postgres:5432/orbitflow_fact32_proof",
    "invalid token: fact32-invalid-token",
  ].join("\n");
  const result = spawnSync("bash", ["-c", 'source scripts/fact-32-telegram-compose-proof.sh; redact_controlled_diagnostic "$1"', "proof", sample], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, FACT32_PROOF_TEST_LIB: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /fact32-(present-token|invalid-token|local-password)/);
  assert.doesNotMatch(result.stdout, /not-a-real-key-for-fact32-proof/);
  assert.match(result.stdout, /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
  assert.match(result.stdout, /OPENROUTER_API_KEY=\[REDACTED\]/);
  assert.match(result.stdout, /POSTGRES_PASSWORD=\[REDACTED\]/);
  assert.match(result.stdout, /postgresql:\/\/orbitflow:\[REDACTED\]@postgres/);
});

test("Telegram Compose proof keeps missing-token diagnostics bounded and tied to a nonzero exit", async () => {
  const proof = await readFile(path.join(repository, "scripts/fact-32-telegram-compose-proof.sh"), "utf8");
  assert.match(proof, /emit_negative_diagnostic "missing-token" "\$missing_exit" "\$missing_output"/);
  assert.match(proof, /compose_run_exit=%s/);
  assert.match(proof, /tail -n 40/);
});

test("Telegram Compose proof uses exact substring checks for retained provider formatting", async () => {
  const fixture = await readFile(path.join(repository, "test/fixtures/fact32-missing-token-diagnostic.txt"), "utf8");
  assert.doesNotMatch(fixture, /\u001B/);

  const legacyPattern = spawnSync("bash", ["-c", '[[ "$1" != *"TELEGRAM_BOT_TOKEN is required" ]]', "proof", fixture], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(legacyPattern.status, 0, "the former missing trailing wildcard misclassifies the retained output");

  for (const expected of ["TELEGRAM_BOT_TOKEN is required", "Unauthorized"]) {
    const positive = spawnSync("bash", ["-c", '[[ "$1" == *"$2"* ]]', "proof", `before ${expected} after`, expected], {
      cwd: repository,
      encoding: "utf8",
    });
    assert.equal(positive.status, 0, `must recognize text before and after ${expected}`);

    const negative = spawnSync("bash", ["-c", '[[ "$1" == *"$2"* ]]', "proof", "before a different failure after", expected], {
      cwd: repository,
      encoding: "utf8",
    });
    assert.equal(negative.status, 1, `must not broaden ${expected}`);
  }

  const proof = await readFile(path.join(repository, "scripts/fact-32-telegram-compose-proof.sh"), "utf8");
  assert.match(proof, /\[\[ "\$missing_output" != \*"TELEGRAM_BOT_TOKEN is required"\* \]\]/);
  assert.match(proof, /\[\[ "\$invalid_output" != \*"Unauthorized"\* \]\]/);
});
