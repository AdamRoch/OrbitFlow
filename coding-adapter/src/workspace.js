// Isolated temp git workspace helper, used by the proof script and tests.
// delegate_coding_task itself does not create workspaces -- it operates on
// one that already exists and has at least one commit (so `git diff` has
// something to diff against).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSafeGit } from "./git.js";

export async function createIsolatedGitWorkspace({ prefix = "coding-adapter-" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  runSafeGit(["init", "-q"], { cwd: dir, home: dir });
  const gitHome = path.join(dir, ".git", "isolated-home");
  await writeFile(path.join(dir, ".gitkeep"), "");
  runSafeGit(["add", "-A"], { cwd: dir, home: gitHome });
  runSafeGit(
    [
      "-c",
      "user.email=spike@orbitflow.local",
      "-c",
      "user.name=orbitflow-spike",
      "commit",
      "-q",
      "-m",
      "seed",
    ],
    { cwd: dir, home: gitHome }
  );
  return dir;
}
