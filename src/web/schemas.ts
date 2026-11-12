import { CURRENCIES, MAX_AMOUNT, MAX_DESTINATION_LENGTH, MAX_METADATA_KEYS, MAX_METADATA_LENGTH, MAX_URL_LENGTH, MIN_AMOUNT } from "../domain/input.js";
import { EVENT_TYPES } from "../domain/event.js";

// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml,
// and tests/contracts compares the routes with that file. What a schema cannot say (an http URL in ASCII, no control
// character in a destination) the domain checks, and the answer has the same shape.
const dateTime = { type: "string", format: "date-time" } as const;

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
  },
} as const;

const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const amount = { type: "integer", minimum: MIN_AMOUNT, maximum: MAX_AMOUNT } as const;
const currency = { type: "string", enum: [...CURRENCIES] } as const;
const metadata = {
  type: "object",
  maxProperties: MAX_METADATA_KEYS,
  propertyNames: { minLength: 1, maxLength: MAX_METADATA_LENGTH },
  additionalProperties: { type: "string", maxLength: MAX_METADATA_LENGTH },
} as const;
const returnUrl = { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH } as const;

const session = {
  type: "object",
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["checkout_session"] },
    url: { type: "string" },
    status: { type: "string", enum: ["open", "completed", "declined", "expired"] },
    amount: { type: "integer" },
    currency: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: "string" } },
    successUrl: { type: "string" },
    cancelUrl: { type: "string" },
    createdAt: dateTime,
    expiresAt: dateTime,
  },
} as const;

const payout = {
  type: "object",
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["payout"] },
    status: { type: "string", enum: ["pending", "paid", "failed"] },
    amount: { type: "integer" },
    currency: { type: "string" },
    destination: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: "string" } },
    failureReason: { type: ["string", "null"], enum: ["declined", null] },
    createdAt: dateTime,
    settledAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;

const event = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: [...EVENT_TYPES] },
    created: dateTime,
    data: {
      type: "object",
      properties: { object: { type: "string", enum: ["checkout_session", "payout"] }, id: { type: "string" } },
    },
    delivery: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "delivered", "failed"] },
        attempts: { type: "integer" },
        lastStatus: { type: ["integer", "null"] },
        lastError: { type: ["string", "null"] },
        lastAttemptAt: { type: ["string", "null"], format: "date-time" },
        nextAttemptAt: { type: ["string", "null"], format: "date-time" },
      },
    },
  },
} as const;

const testMode = { type: "object", properties: { declinePayouts: { type: "boolean" } } } as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

export const schemas = {
  createSession: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "currency", "successUrl", "cancelUrl"],
      properties: { amount, currency, metadata, successUrl: returnUrl, cancelUrl: returnUrl },
    },
    response: { 200: session, 201: session, ...errorResponses },
  },
  getSession: { params: idParams, response: { 200: session, ...errorResponses } },
  createPayout: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "currency", "destination"],
      properties: { amount, currency, destination: { type: "string", minLength: 1, maxLength: MAX_DESTINATION_LENGTH }, metadata },
    },
    response: { 200: payout, 201: payout, ...errorResponses },
  },
  getPayout: { params: idParams, response: { 200: payout, ...errorResponses } },
  getEvent: { params: idParams, response: { 200: event, ...errorResponses } },
  getTestMode: { response: { 200: testMode, ...errorResponses } },
  setTestMode: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["declinePayouts"],
      properties: { declinePayouts: { type: "boolean" } },
    },
    response: { 200: testMode, ...errorResponses },
  },
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
  // The payment page routes answer HTML, so they declare no response schema; their params are checked like the others.
  page: { params: idParams },
} as const;
