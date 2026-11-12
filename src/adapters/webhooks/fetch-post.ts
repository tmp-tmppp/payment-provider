import type { PostFn } from "./webhook-sender.js";

/**
 * The real POST: Node's fetch with a hard time limit. A redirect is not followed (it counts as a failed attempt, so
 * the signed body can never be sent to a place the operator did not configure), and the answer body is dropped.
 */
export const fetchPost: PostFn = async ({ url, headers, body, timeoutMs }) => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  return { status: response.status };
};
