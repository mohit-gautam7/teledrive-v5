"use client";

import { useSyncExternalStore } from "react";
import { assetUrl, fileAuthVersion, subscribeFileAuth } from "@/lib/file-origin";

/**
 * A URL for a tag the browser fetches itself, kept current as the token changes.
 *
 * `assetUrl` is synchronous because it is called during render, which means the
 * very first render of a tile happens before the file token has arrived — it
 * would otherwise render an unauthenticated URL and never correct it. Subscribing
 * to the token store is what turns the token landing into a re-render.
 *
 * `getServerSnapshot` returns 0 so the server and the hydrating client agree on
 * a token-free URL, and React re-renders with the real one immediately after.
 * On a single-origin deployment this is a no-op wrapper around the path itself.
 */
export function useAssetUrl(path: string) {
  useSyncExternalStore(subscribeFileAuth, fileAuthVersion, () => 0);
  return assetUrl(path);
}
