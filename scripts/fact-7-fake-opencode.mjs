#!/usr/bin/env node

const expectedKeys = [
  "HOME",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENROUTER_API_KEY",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

if (
  process.env.OPENROUTER_API_KEY !== "not-a-real-key-for-structural-compose-proof" ||
  JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(expectedKeys)
) {
  process.exitCode = 41;
} else {
  const sessionID = "fact7-proof";
  process.stdout.write(
    `${JSON.stringify({
      type: "step_start",
      timestamp: 1,
      sessionID,
      part: { id: "start", sessionID, messageID: "message", type: "step-start" },
    })}\n`
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "step_finish",
      timestamp: 2,
      sessionID,
      part: {
        id: "finish",
        sessionID,
        messageID: "message",
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })}\n`
  );
}
