import { apiUrl, fileAuthHeaders } from "@/lib/file-origin";

export class ApiError extends Error {
  status: number;
  /** The parsed error body, for the few callers that need more than its message
   *  — a 409 duplicate carries the id of the file it collided with. */
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Deliberate messages from the server win; generic text covers the rest.
 *
 * This used to return the generic text unconditionally, which discarded
 * everything useful — a Telegram rate limit saying "try again in 7h 18m" and a
 * genuine crash both reached the user as "The server had a problem."
 *
 * 401 and 5xx stay generic on purpose. A 5xx body is an unhandled exception's
 * message, which can carry table names, file paths or connection strings, and
 * none of it helps the person reading the toast.
 */
function friendlyStatus(status: number, serverMessage: string, ref?: string) {
  if (status === 401) return "Your session expired. Please sign in again.";
  // 503 is the one 5xx the server raises deliberately — "the database is busy",
  // written for a human. Hiding it behind the generic text would throw away the
  // only 5xx we can explain.
  if (status === 503 && serverMessage.trim() && serverMessage.toLowerCase() !== "service unavailable") {
    return serverMessage.trim();
  }
  // The 5xx body is an unhandled exception's message and can carry table names
  // or connection strings, so it stays hidden. The reference does not — it is a
  // random tag printed next to the stack in the server log, which turns "the
  // server had a problem" into something reportable.
  if (status >= 500) {
    return ref
      ? `The server had a problem (ref ${ref}). Please try again.`
      : "The server had a problem. Please try again.";
  }

  const message = serverMessage.trim();
  if (message && message.toLowerCase() !== "internal server error") return message;

  if (status === 403) return "You do not have permission to do that.";
  if (status === 413) return "File too large — exceeds the server's maximum upload size.";
  if (status === 429) return "Too many requests. Please wait a moment and try again.";
  return `Request failed (HTTP ${status}).`;
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!response.ok) {
    const body = isJson ? await response.json().catch(() => null) : await response.text().catch(() => "");
    const message = typeof body === "object" && body && "error" in body ? String(body.error) : String(body || response.statusText);
    const ref = typeof body === "object" && body && "ref" in body ? String((body as { ref?: unknown }).ref) : undefined;
    throw new ApiError(friendlyStatus(response.status, message, ref), response.status, body);
  }

  if (!isJson) {
    const text = await response.text().catch(() => "");
    throw new ApiError(text ? `Expected JSON but received: ${text.slice(0, 120)}` : "The server returned an empty response.", response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("The server returned invalid JSON. Please try again.", response.status);
  }
}

/**
 * One call, sent to whichever origin owns it.
 *
 * On a single-origin deployment `apiUrl` hands the path back unchanged and
 * `fileAuthHeaders` is empty, so this is a plain fetch and nothing about the
 * app's behaviour changes. On a split deployment the heavy paths are rewritten
 * to the file origin and carry a bearer token, because the session cookie
 * cannot cross to it. Every caller goes through here, so no call site has to
 * know which of the two it is.
 */
export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof input === "string" && input.startsWith("/")) {
    const url = apiUrl(input);
    const extra = url === input ? {} : await fileAuthHeaders();
    const response = await fetch(url, {
      ...init,
      headers: { ...((init?.headers as Record<string, string>) ?? {}), ...extra }
    });
    return parseResponse<T>(response);
  }
  const response = await fetch(input, init);
  return parseResponse<T>(response);
}

/** `fetch`, routed and authenticated the same way, for callers that need the
 *  raw Response — a streamed download, a chunk PUT that reads its own body. */
export async function fileFetch(path: string, init?: RequestInit) {
  const url = apiUrl(path);
  const extra = url === path ? {} : await fileAuthHeaders();
  return fetch(url, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), ...extra } });
}

type UploadResult<T> = {
  data: T;
};

export class UploadAbortedError extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "UploadAbortedError";
  }
}

/**
 * XHR rather than fetch, because only XHR reports upload progress.
 *
 * The token has to be resolved before `open`, so this is async up front and the
 * promise the caller sees still resolves with the response — the shape has not
 * changed. On a single origin `fileAuthHeaders` is empty and no header is set.
 */
export function uploadFile<T>(
  url: string,
  form: FormData,
  onProgress: (progress: number) => void,
  signal?: AbortSignal
): Promise<UploadResult<T>> {
  return new Promise((resolve, reject) => {
    const target = apiUrl(url);

    const start = (auth: Record<string, string>) => {
    // Abort can land while the token is being minted; the request must not then
    // be sent at all.
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", target);
    // After open(), which is the only place setRequestHeader is legal.
    for (const [key, value] of Object.entries(auth)) xhr.setRequestHeader(key, value);
    xhr.responseType = "text";
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new ApiError("Network error during upload. Please retry.", xhr.status || 0));
    xhr.onabort = () => reject(new UploadAbortedError());
    xhr.onload = () => {
      const contentType = xhr.getResponseHeader("content-type") || "";
      const text = xhr.responseText || "";
      if (xhr.status < 200 || xhr.status >= 300) {
        if (contentType.includes("application/json")) {
          try {
            const parsed = JSON.parse(text) as { error?: string };
            reject(new ApiError(friendlyStatus(xhr.status, parsed.error || xhr.statusText), xhr.status, parsed));
            return;
          } catch {
            reject(new ApiError("Upload failed with an unreadable server error.", xhr.status));
            return;
          }
        }
        reject(new ApiError(friendlyStatus(xhr.status, text || xhr.statusText), xhr.status));
        return;
      }
      if (!contentType.includes("application/json")) {
        reject(new ApiError(text ? `Upload returned non-JSON response: ${text.slice(0, 120)}` : "Upload returned an empty response.", xhr.status));
        return;
      }
      try {
        resolve({ data: JSON.parse(text) as T });
      } catch {
        reject(new ApiError("Upload succeeded, but the server returned invalid JSON.", xhr.status));
      }
    };
    if (signal) {
      if (signal.aborted) {
        reject(new UploadAbortedError());
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
    };

    // Same origin: no token to wait for, so the request starts in this tick
    // exactly as it always did. Cross-origin: one await for a token that is
    // cached after the first upload of the session.
    if (target === url) start({});
    else fileAuthHeaders().then(start, () => start({}));
  });
}
