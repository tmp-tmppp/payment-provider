import { randomBytes } from "node:crypto";
import type { Clock, IdGenerator } from "../usecases/ports.js";

export const systemClock: Clock = { now: () => new Date() };

/** A prefix and 18 random bytes in base64url: 24 characters, no padding, 144 bits. */
const newId = (prefix: string): string => `${prefix}_${randomBytes(18).toString("base64url")}`;

export const randomIds: IdGenerator = {
  newSessionId: () => newId("cs"),
  newPayoutId: () => newId("po"),
  newEventId: () => newId("evt"),
};
