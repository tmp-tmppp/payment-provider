import { NotFound } from "./errors.js";
import type { StoredEvent, TestMode, UseCaseDeps } from "./ports.js";

/** GET /v1/test-mode */
export class GetTestMode {
  constructor(private readonly deps: UseCaseDeps) {}

  execute(): Promise<TestMode> {
    return this.deps.store.getTestMode();
  }
}

/** PUT /v1/test-mode: for demos, so that the withdrawal saga can be made to fail on purpose. */
export class SetTestMode {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(mode: TestMode): Promise<TestMode> {
    await this.deps.store.setTestMode({ declinePayouts: mode.declinePayouts });
    this.deps.logger.info({ declinePayouts: mode.declinePayouts }, "The test mode was changed");
    return this.deps.store.getTestMode();
  }
}

/** GET /v1/events/{id}: an event and how far its delivery has got, for debugging. */
export class GetEvent {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(id: string): Promise<StoredEvent> {
    const stored = await this.deps.store.getEvent(id);
    if (!stored) throw new NotFound("event_not_found", "No such event");
    return stored;
  }
}
