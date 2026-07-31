import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { requireEnv } from "@/lib/env";
import { MTPROTO_PART_SIZE } from "@/lib/upload-config";

/**
 * Per-user MTProto ("personal session") access.
 *
 * This is the only route to true multi-gigabyte single files: the Bot API can
 * download at most 20 MB, so bot storage has to chunk, whereas a real user
 * session stores one 2 GB file (4 GB with Premium) as a single message.
 *
 * Everything here is written to survive serverless: a client is rebuilt from the
 * session string on each invocation, and Telegram keys an in-progress big-file
 * upload on (user, fileId) server-side, so parts may arrive across many separate
 * requests. That is what makes 2 GB uploads possible under a 4.5 MB body limit.
 */

const clients = new Map<string, TelegramClient>();

function apiCredentials() {
  return { apiId: Number(requireEnv("API_ID")), apiHash: String(requireEnv("API_HASH")) };
}

export function mtprotoConfigured() {
  return Boolean(process.env.API_ID && process.env.API_HASH);
}

async function connect(sessionString: string): Promise<TelegramClient> {
  const cached = clients.get(sessionString);
  if (cached?.connected) return cached;

  const { apiId, apiHash } = apiCredentials();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
    requestRetries: 3
  });
  await client.connect();
  clients.set(sessionString, client);
  return client;
}

/** Run `fn` against a client built from `sessionString` (empty string = fresh). */
export async function withUserClient<T>(sessionString: string, fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const client = await connect(sessionString);
  return fn(client);
}

// ── Authorisation: QR ────────────────────────────────────────────────────────

export type QrStart = { pendingSession: string; qrUrl: string; expiresAt: number };

/** Step 1 of QR login: export a login token and hand back the tg:// URL to render.
 *  The half-built session must be persisted — step 2 needs the same auth key. */
export async function startQrLogin(): Promise<QrStart> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connect("");
  const result = await client.invoke(
    new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] })
  );
  if (!(result instanceof Api.auth.LoginToken)) {
    throw new Error("Telegram did not return a QR login token.");
  }
  const token = Buffer.from(result.token).toString("base64url");
  const pendingSession = (client.session as StringSession).save();
  return {
    pendingSession,
    qrUrl: `tg://login?token=${token}`,
    expiresAt: result.expires * 1000
  };
}

export type QrPoll =
  | { status: "pending" }
  | { status: "password"; pendingSession: string }
  | { status: "authorized"; session: string; userId: string; premium: boolean; name: string };

/** Step 2 of QR login: re-export the token; Telegram answers with the account
 *  once the user has scanned it. `migrateTo` means retry against another DC. */
export async function pollQrLogin(pendingSession: string): Promise<QrPoll> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connect(pendingSession);
  try {
    const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));

    if (result instanceof Api.auth.LoginTokenSuccess) {
      return authorizedResult(client);
    }
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result.dcId);
      const migrated = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
      if (migrated instanceof Api.auth.LoginTokenSuccess) return authorizedResult(client);
    }
    return { status: "pending" };
  } catch (err) {
    const message = (err as Error).message || "";
    if (message.includes("SESSION_PASSWORD_NEEDED")) {
      return { status: "password", pendingSession: (client.session as StringSession).save() };
    }
    throw err;
  }
}

async function authorizedResult(client: TelegramClient): Promise<QrPoll & { status: "authorized" }> {
  const me = (await client.getMe()) as Api.User;
  return {
    status: "authorized",
    session: (client.session as StringSession).save(),
    userId: String(me.id),
    premium: Boolean(me.premium),
    name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram user"
  };
}

// ── Authorisation: phone + code ──────────────────────────────────────────────

export async function startPhoneLogin(phone: string): Promise<{ pendingSession: string; phoneCodeHash: string }> {
  const { apiId, apiHash } = apiCredentials();
  const client = await connect("");
  const sent = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({})
    })
  );
  if (!(sent instanceof Api.auth.SentCode)) {
    throw new Error("Telegram could not send a login code to that number.");
  }
  return { pendingSession: (client.session as StringSession).save(), phoneCodeHash: sent.phoneCodeHash };
}

export type Authorized = { status: "authorized"; session: string; userId: string; premium: boolean; name: string };
export type SignInResult = { status: "password"; pendingSession: string } | Authorized;

export async function signInWithCode(
  pendingSession: string,
  phone: string,
  phoneCodeHash: string,
  code: string
): Promise<SignInResult> {
  const client = await connect(pendingSession);
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
  } catch (err) {
    if (((err as Error).message || "").includes("SESSION_PASSWORD_NEEDED")) {
      return { status: "password", pendingSession: (client.session as StringSession).save() };
    }
    throw err;
  }
  return authorizedResult(client);
}

/** Two-factor step — required when the account has a cloud password set. */
export async function signInWithPassword(pendingSession: string, password: string): Promise<Authorized> {
  const client = await connect(pendingSession);
  const pwd = await client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwd, password);
  await client.invoke(new Api.auth.CheckPassword({ password: check }));
  return authorizedResult(client);
}

// ── Big-file upload ──────────────────────────────────────────────────────────

/**
 * Push one slice of a big file. `offsetPart` is the index of the first 512 KiB
 * part contained in `data`, so a 4 MiB browser chunk covers 8 consecutive parts.
 * Telegram accepts parts in any order across any number of connections.
 */
export async function saveBigFileParts(
  session: string,
  fileId: string,
  offsetPart: number,
  totalParts: number,
  data: Buffer
): Promise<number> {
  const client = await connect(session);
  const id = bigInt(fileId);
  let written = 0;
  for (let at = 0; at < data.length; at += MTPROTO_PART_SIZE) {
    const slice = data.subarray(at, Math.min(at + MTPROTO_PART_SIZE, data.length));
    await client.invoke(
      new Api.upload.SaveBigFilePart({
        fileId: id,
        filePart: offsetPart + written,
        fileTotalParts: totalParts,
        bytes: slice
      })
    );
    written++;
  }
  return written;
}

/** Turn the uploaded parts into a real message in the user's Saved Messages. */
export async function finalizeBigFile(params: {
  session: string;
  fileId: string;
  totalParts: number;
  fileName: string;
  mimeType: string;
  caption?: string;
}): Promise<{ messageId: number }> {
  const client = await connect(params.session);
  const input = new Api.InputFileBig({
    id: bigInt(params.fileId),
    parts: params.totalParts,
    name: params.fileName
  });
  const message = await client.sendFile("me", {
    file: input,
    forceDocument: true,
    caption: params.caption?.slice(0, 1000),
    attributes: [new Api.DocumentAttributeFilename({ fileName: params.fileName })]
  });
  return { messageId: message.id };
}

// ── Ranged download ──────────────────────────────────────────────────────────

type DocumentRef = { id: bigInt.BigInteger; accessHash: bigInt.BigInteger; fileReference: Buffer; dcId: number };

async function resolveDocument(client: TelegramClient, msgId: number): Promise<DocumentRef> {
  const messages = await client.getMessages("me", { ids: [msgId] });
  const media = messages[0]?.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
    throw new Error(`Message ${msgId} no longer holds a document.`);
  }
  const doc = media.document;
  return {
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: Buffer.from(doc.fileReference),
    dcId: doc.dcId
  };
}

/**
 * Read `[start, end]` (inclusive) of an MTProto-stored file.
 *
 * Telegram requires offsets aligned to the part size, so we round down, fetch
 * whole parts, and trim. Nothing larger than the requested window is ever held
 * in memory — that is what keeps a 2 GB file streamable from a 1 GB function.
 */
export async function downloadRange(session: string, msgId: number, start: number, end: number): Promise<Buffer> {
  const client = await connect(session);
  const doc = await resolveDocument(client, msgId);

  const alignedStart = Math.floor(start / MTPROTO_PART_SIZE) * MTPROTO_PART_SIZE;
  const wanted = end - start + 1;
  const toFetch = start - alignedStart + wanted;

  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: ""
  });

  const parts: Buffer[] = [];
  let collected = 0;
  const iterator = client.iterDownload({
    file: location,
    offset: bigInt(alignedStart),
    requestSize: MTPROTO_PART_SIZE,
    limit: Math.ceil(toFetch / MTPROTO_PART_SIZE),
    dcId: doc.dcId
  });
  for await (const buf of iterator) {
    parts.push(buf as Buffer);
    collected += (buf as Buffer).length;
    if (collected >= toFetch) break;
  }
  await iterator.close();

  const joined = Buffer.concat(parts);
  const from = start - alignedStart;
  return joined.subarray(from, from + wanted);
}

/** Remove an MTProto-stored file from the user's Saved Messages. */
export async function deleteUserMessages(session: string, msgIds: number[]): Promise<void> {
  if (!msgIds.length) return;
  try {
    const client = await connect(session);
    for (let i = 0; i < msgIds.length; i += 100) {
      await client.deleteMessages("me", msgIds.slice(i, i + 100), { revoke: true });
    }
  } catch (err) {
    console.error("[telegram-user] deleteMessages failed:", (err as Error).message);
  }
}
