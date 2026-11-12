import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodicJob, TimerScheduler } from "../../src/adapters/timers.js";
import { RecordingLogger } from "../support/harness.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("TimerScheduler", () => {
  it("runs a task once, after its delay", async () => {
    const scheduler = new TimerScheduler(new RecordingLogger());
    const task = vi.fn();
    scheduler.after(2000, task);
    await vi.advanceTimersByTimeAsync(1999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("logs a task that fails and keeps working", async () => {
    const logger = new RecordingLogger();
    const scheduler = new TimerScheduler(logger);
    const later = vi.fn();
    scheduler.after(10, () => Promise.reject(new Error("no")));
    scheduler.after(20, later);
    await vi.advanceTimersByTimeAsync(20);
    expect(logger.lines.filter((line) => line.message === "A scheduled task failed")).toHaveLength(1);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("drops the tasks that have not started when it stops, says so, and takes no more", async () => {
    const logger = new RecordingLogger();
    const scheduler = new TimerScheduler(logger);
    const task = vi.fn();
    scheduler.after(1000, task);
    scheduler.after(2000, task);
    await scheduler.stop();
    scheduler.after(10, task);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", message: "Scheduled tasks were dropped at shutdown", fields: { dropped: 2 } });
  });

  it("waits for a task that is running when it stops", async () => {
    const scheduler = new TimerScheduler(new RecordingLogger());
    let finish: () => void = () => undefined;
    scheduler.after(10, () => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("PeriodicJob", () => {
  it("runs on every tick, one run at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const job = new PeriodicJob({
      name: "test",
      everyMs: 100,
      logger: new RecordingLogger(),
      run: async () => {
        runs += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 250));
        running -= 1;
      },
    });
    job.start();
    job.start(); // a second start changes nothing
    await vi.advanceTimersByTimeAsync(1000);
    // A run may be going: stopping waits for it, and its own timer needs the clock to move.
    const stopping = job.stop();
    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    expect(maxRunning).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(3);
    const after = runs;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(after);
  });

  it("logs a run that fails and runs again at the next tick", async () => {
    const logger = new RecordingLogger();
    let runs = 0;
    const job = new PeriodicJob({
      name: "flaky",
      everyMs: 100,
      logger,
      run: () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error("once")) : Promise.resolve();
      },
    });
    job.start();
    await vi.advanceTimersByTimeAsync(250);
    await job.stop();
    expect(runs).toBe(2);
    expect(logger.lines.filter((line) => line.message === "A periodic job failed")).toHaveLength(1);
  });

  it("can be stopped before it was started", async () => {
    await new PeriodicJob({ name: "x", everyMs: 10, logger: new RecordingLogger(), run: () => Promise.resolve() }).stop();
  });
});
