import type { CompleteCheckout, CreateCheckoutSession, GetCheckoutSession } from "../usecases/checkout-sessions.js";
import type { CreatePayout, GetPayout } from "../usecases/payouts.js";
import type { GetEvent, GetTestMode, SetTestMode } from "../usecases/test-mode.js";

export interface UseCases {
  createCheckoutSession: CreateCheckoutSession;
  getCheckoutSession: GetCheckoutSession;
  completeCheckout: CompleteCheckout;
  createPayout: CreatePayout;
  getPayout: GetPayout;
  getTestMode: GetTestMode;
  setTestMode: SetTestMode;
  getEvent: GetEvent;
}
