import { bigint, int, json, longtext, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const folders = mysqlTable("folders", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: text("name").notNull(),
  parentId: int("parentId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Folder = typeof folders.$inferSelect;
export type InsertFolder = typeof folders.$inferInsert;

export const files = mysqlTable("files", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  folderId: int("folderId"),
  name: text("name").notNull(),
  mimeType: varchar("mimeType", { length: 255 }),
  size: bigint("size", { mode: "number" }).notNull(),
  storageMode: mysqlEnum("storageMode", ["botStorage", "personalSavedMessages", "localAgent"]).notNull(),
  routingReason: mysqlEnum("routingReason", [
    "videoAlwaysPersonal",
    "imageUnderLimit",
    "imageOverflowToPersonal",
    "fileUnderLimit",
    "fileOverflowToPersonal",
    "userOverride",
  ]).notNull(),
  userOverriddenMode: mysqlEnum("userOverriddenMode", ["botStorage", "personalSavedMessages"]),
  telegramDestination: varchar("telegramDestination", { length: 255 }).notNull(),
  telegramFileId: text("telegramFileId"),
  telegramMessageId: varchar("telegramMessageId", { length: 255 }),
  thumbnailUrl: text("thumbnailUrl"),
  shareToken: varchar("shareToken", { length: 255 }).unique(),
  isShared: boolean("isShared").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  deletedAt: timestamp("deletedAt"),
});

export type File = typeof files.$inferSelect;
export type InsertFile = typeof files.$inferInsert;

export const telegramSessions = mysqlTable("telegramSessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  sessionData: longtext("sessionData").notNull(),
  isValid: boolean("isValid").default(true).notNull(),
  lastValidated: timestamp("lastValidated").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TelegramSession = typeof telegramSessions.$inferSelect;
export type InsertTelegramSession = typeof telegramSessions.$inferInsert;

export const storageConfigs = mysqlTable("storageConfigs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  botToken: text("botToken"),
  botUsername: varchar("botUsername", { length: 255 }),
  botChannelId: varchar("botChannelId", { length: 255 }),
  botChannelName: varchar("botChannelName", { length: 255 }),
  personalStorageMode: mysqlEnum("personalStorageMode", ["savedMessages", "dedicatedGroup", "none"]).default("none"),
  personalStorageGroupId: varchar("personalStorageGroupId", { length: 255 }),
  isBotConfigured: boolean("isBotConfigured").default(false).notNull(),
  isPersonalConfigured: boolean("isPersonalConfigured").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StorageConfig = typeof storageConfigs.$inferSelect;
export type InsertStorageConfig = typeof storageConfigs.$inferInsert;

export const shareTokens = mysqlTable("shareTokens", {
  id: int("id").autoincrement().primaryKey(),
  fileId: int("fileId").notNull(),
  userId: int("userId").notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ShareToken = typeof shareTokens.$inferSelect;
export type InsertShareToken = typeof shareTokens.$inferInsert;

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  files: many(files),
  folders: many(folders),
  sessions: many(telegramSessions),
  storageConfig: many(storageConfigs),
}));

export const filesRelations = relations(files, ({ one }) => ({
  user: one(users, { fields: [files.userId], references: [users.id] }),
  folder: one(folders, { fields: [files.folderId], references: [folders.id] }),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  user: one(users, { fields: [folders.userId], references: [users.id] }),
  files: many(files),
  subfolders: many(folders),
}));