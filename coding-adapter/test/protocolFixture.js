const SESSION_ID = "ses_test";
export const TEST_CREDENTIAL = "or-secret-1234567890";

function base(type) {
  return { type, timestamp: 1, sessionID: SESSION_ID };
}

function part(type, id) {
  return {
    id,
    sessionID: SESSION_ID,
    messageID: "msg_test",
    type,
  };
}

export function stepStart(id = "part_start") {
  return { ...base("step_start"), part: part("step-start", id) };
}

export function stepFinish(
  {
    input = 1,
    output = 1,
    reasoning = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0,
  } = {},
  id = "part_finish"
) {
  return {
    ...base("step_finish"),
    part: {
      ...part("step-finish", id),
      reason: "stop",
      cost,
      tokens: {
        input,
        output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
    },
  };
}

export function textEvent(text, id = "part_text") {
  return { ...base("text"), part: { ...part("text", id), text } };
}

export function errorEvent() {
  return { ...base("error"), error: { name: "ProviderError" } };
}

export function ndjson(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function successfulRun() {
  return ndjson([stepStart(), stepFinish()]);
}
