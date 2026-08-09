// Isolated temp git workspace helper, used by the proof script and tests.
// delegate_coding_task itself does not create workspaces -- it operates on
// one that already exists and has at least one commit (so `git diff` has
// something to diff against).

import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createIsolatedGitWorkspace({ prefix = "coding-adapter-" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "spike@orbitflow.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "orbitflow-spike"], { cwd: dir });
  await writeFile(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}
