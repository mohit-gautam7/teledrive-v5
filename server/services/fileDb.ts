/**
 * File Database Query Helpers
 */

import { eq, and, isNull, desc, asc } from "drizzle-orm";
import {
  files,
  folders,
  storageConfigs,
  telegramSessions,
  shareTokens,
  type File,
  type Folder,
  type StorageConfig,
  type TelegramSession,
  type ShareToken,
  type InsertFile,
  type InsertFolder,
  type InsertStorageConfig,
  type InsertTelegramSession,
  type InsertShareToken,
} from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * File operations
 */
export async function createFile(data: InsertFile): Promise<File> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(files).values(data);
  const fileId = result[0].insertId;

  const created = await db.select().from(files).where(eq(files.id, fileId));
  return created[0]!;
}

export async function getFile(fileId: number, userId: number): Promise<File | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)));

  return result[0];
}

export async function getFileByShareToken(token: string): Promise<File | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(files)
    .where(and(eq(files.shareToken, token), eq(files.isShared, true)));

  return result[0];
}

export async function listFiles(
  userId: number,
  folderId?: number,
  limit: number = 100,
  offset: number = 0
): Promise<File[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [
    eq(files.userId, userId),
    isNull(files.deletedAt),
  ];

  if (folderId !== undefined) {
    conditions.push(eq(files.folderId, folderId));
  } else {
    conditions.push(isNull(files.folderId));
  }

  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(desc(files.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function updateFile(
  fileId: number,
  userId: number,
  data: Partial<File>
): Promise<File | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(files)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(files.id, fileId), eq(files.userId, userId)));

  return getFile(fileId, userId);
}

export async function deleteFile(fileId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(files)
    .set({ deletedAt: new Date() })
    .where(and(eq(files.id, fileId), eq(files.userId, userId)));
}

export async function getStorageStats(userId: number): Promise<{
  totalFiles: number;
  totalSize: number;
  botFiles: number;
  botSize: number;
  personalFiles: number;
  personalSize: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const allFiles = await db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), isNull(files.deletedAt)));

  let totalSize = 0;
  let botSize = 0;
  let personalSize = 0;
  let botCount = 0;
  let personalCount = 0;

  for (const file of allFiles) {
    totalSize += file.size;
    if (file.storageMode === "botStorage") {
      botSize += file.size;
      botCount++;
    } else if (file.storageMode === "personalSavedMessages") {
      personalSize += file.size;
      personalCount++;
    }
  }

  return {
    totalFiles: allFiles.length,
    totalSize,
    botFiles: botCount,
    botSize,
    personalFiles: personalCount,
    personalSize,
  };
}

/**
 * Folder operations
 */
export async function createFolder(data: InsertFolder): Promise<Folder> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(folders).values(data);
  const folderId = result[0].insertId;

  const created = await db.select().from(folders).where(eq(folders.id, folderId));
  return created[0]!;
}

export async function getFolder(folderId: number, userId: number): Promise<Folder | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));

  return result[0];
}

export async function listFolders(userId: number, parentId?: number): Promise<Folder[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [eq(folders.userId, userId)];

  if (parentId !== undefined) {
    conditions.push(eq(folders.parentId, parentId));
  } else {
    conditions.push(isNull(folders.parentId));
  }

  return db
    .select()
    .from(folders)
    .where(and(...conditions))
    .orderBy(asc(folders.name));
}

export async function updateFolder(
  folderId: number,
  userId: number,
  data: Partial<Folder>
): Promise<Folder | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(folders)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));

  return getFolder(folderId, userId);
}

export async function deleteFolder(folderId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Delete all files in folder
  await db
    .update(files)
    .set({ deletedAt: new Date() })
    .where(and(eq(files.folderId, folderId), eq(files.userId, userId)));

  // Delete folder
  await db
    .delete(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
}

/**
 * Storage configuration operations
 */
export async function getStorageConfig(userId: number): Promise<StorageConfig | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(storageConfigs)
    .where(eq(storageConfigs.userId, userId));

  return result[0];
}

export async function upsertStorageConfig(
  userId: number,
  data: Partial<InsertStorageConfig>
): Promise<StorageConfig> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getStorageConfig(userId);

  if (existing) {
    await db
      .update(storageConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(storageConfigs.userId, userId));
  } else {
    const insertData: InsertStorageConfig = {
      userId,
      ...data,
    };
    await db.insert(storageConfigs).values(insertData);
  }

  const config = await getStorageConfig(userId);
  if (!config) throw new Error("Failed to upsert storage config");
  return config;
}

/**
 * Telegram session operations
 */
export async function getTelegramSession(userId: number): Promise<TelegramSession | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(telegramSessions)
    .where(eq(telegramSessions.userId, userId));

  return result[0];
}

export async function upsertTelegramSession(
  userId: number,
  data: Partial<InsertTelegramSession>
): Promise<TelegramSession> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getTelegramSession(userId);

  if (existing) {
    await db
      .update(telegramSessions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(telegramSessions.userId, userId));
  } else {
    const insertData: InsertTelegramSession = {
      userId,
      phoneNumber: data.phoneNumber || "",
      sessionData: data.sessionData || "",
    };
    await db.insert(telegramSessions).values(insertData);
  }

  const session = await getTelegramSession(userId);
  if (!session) throw new Error("Failed to upsert telegram session");
  return session;
}

export async function invalidateTelegramSession(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(telegramSessions)
    .set({ isValid: false, updatedAt: new Date() })
    .where(eq(telegramSessions.userId, userId));
}

/**
 * Share token operations
 */
export async function createShareToken(data: InsertShareToken): Promise<ShareToken> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(shareTokens).values(data);
  const tokenId = result[0].insertId;

  const created = await db.select().from(shareTokens).where(eq(shareTokens.id, tokenId));
  return created[0]!;
}

export async function getShareToken(token: string): Promise<ShareToken | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.token, token));

  return result[0];
}

export async function deleteShareToken(token: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(shareTokens).where(eq(shareTokens.token, token));
}
