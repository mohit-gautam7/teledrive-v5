export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
function friendlyStatus(status: number, serverMessage: string) {
  if (status === 401) return "Your session expired. Please sign in again.";
  if (status >= 500) return "The server had a problem. Please try again.";

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
    throw new ApiError(friendlyStatus(response.status, message), response.status);
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

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  return parseResponse<T>(response);
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

export function uploadFile<T>(
  url: string,
  form: FormData,
  onProgress: (progress: number) => void,
  signal?: AbortSignal
): Promise<UploadResult<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
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
            reject(new ApiError(friendlyStatus(xhr.status, parsed.error || xhr.statusText), xhr.status));
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
  });
}
