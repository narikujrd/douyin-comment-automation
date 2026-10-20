import fs from "node:fs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAndRemoveDecisionFile(decisionPath) {
  if (!decisionPath) {
    return null;
  }
  try {
    const value = fs.readFileSync(decisionPath, "utf8");
    fs.unlinkSync(decisionPath);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class InteractiveDecisionInbox {
  constructor(lineIterator, options = {}) {
    this.lineIterator = lineIterator || null;
    this.pollIntervalMs = Math.max(10, Number(options.pollIntervalMs) || 120);
    this.pendingLine = null;
    this.stdinClosed = !lineIterator;
  }

  getPendingLine() {
    if (this.stdinClosed) {
      return null;
    }
    if (!this.pendingLine) {
      this.pendingLine = this.lineIterator.next().then((result) => ({
        kind: "line",
        result
      }));
    }
    return this.pendingLine;
  }

  async next(options = {}) {
    const decisionPath = options.decisionPath || "";
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 1);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const fileValue = readAndRemoveDecisionFile(decisionPath);
      if (fileValue !== null) {
        return { source: "file", value: fileValue, done: false };
      }

      if (this.stdinClosed && !decisionPath) {
        return { source: "stdin", value: "", done: true };
      }

      const remainingMs = Math.max(1, deadline - Date.now());
      const waitMs = Math.min(this.pollIntervalMs, remainingMs);
      const pendingLine = this.getPendingLine();
      if (!pendingLine) {
        await sleep(waitMs);
        continue;
      }

      const outcome = await Promise.race([
        pendingLine,
        sleep(waitMs).then(() => ({ kind: "poll" }))
      ]);
      if (outcome.kind === "poll") {
        continue;
      }

      this.pendingLine = null;
      if (outcome.result.done) {
        this.stdinClosed = true;
        continue;
      }
      return {
        source: "stdin",
        value: String(outcome.result.value ?? ""),
        done: false
      };
    }

    throw new Error(`Decision timed out after ${timeoutMs}ms.`);
  }
}
