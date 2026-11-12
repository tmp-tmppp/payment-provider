import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export const readContract = (file: string): string => readFileSync(new URL(`../../contracts/${file}`, import.meta.url), "utf8");

export const openapi = parse(readContract("openapi.yaml")) as Record<string, any>;

// OpenAPI 3.1 schemas are JSON Schema 2020-12.
const openapiAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(openapiAjv);

const errorsOf = (validate: { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null }, body: unknown): string[] =>
  validate(body) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);

/** Errors of a body against the schema of an operation's JSON response in contracts/openapi.yaml; empty = valid. */
export function responseErrors(path: string, method: string, status: number | string, body: unknown): string[] {
  const response = openapi["paths"][path]?.[method.toLowerCase()]?.responses?.[String(status)];
  if (!response) return [`${method} ${path} has no ${status} response in the contract`];
  const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop()!] : response;
  const content = resolved.content?.["application/json"] ?? resolved.content?.["application/problem+json"];
  if (!content) return [`${method} ${path} ${status} documents no JSON body`];
  return errorsOf(openapiAjv.compile({ components: openapi["components"], ...content.schema }), body);
}

/** Errors of a value against a named schema of components, for example "WebhookEvent". */
export function schemaErrors(name: string, body: unknown): string[] {
  return errorsOf(openapiAjv.compile({ components: openapi["components"], $ref: `#/components/schemas/${name}` }), body);
}

/** Errors of a request body against the schema of an operation's request body. */
export function requestErrors(path: string, method: string, body: unknown): string[] {
  const schema = openapi["paths"][path]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return [`${method} ${path} has no JSON request body in the contract`];
  return errorsOf(openapiAjv.compile({ components: openapi["components"], ...schema }), body);
}
