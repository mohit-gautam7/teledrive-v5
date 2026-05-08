import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as fileDb from "./services/fileDb";
import { determineRouting, getRoutingExplanation, getStorageModeDisplayName } from "./services/fileRouter";
import { nanoid } from "nanoid";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  files: router({
    list: protectedProcedure
      .input(z.object({ folderId: z.number().optional(), limit: z.number().default(100), offset: z.number().default(0) }))
      .query(async ({ ctx, input }) => {
        const files = await fileDb.listFiles(ctx.user.id, input.folderId, input.limit, input.offset);
        return files;
      }),

    get: protectedProcedure
      .input(z.object({ fileId: z.number() }))
      .query(async ({ ctx, input }) => {
        const file = await fileDb.getFile(input.fileId, ctx.user.id);
        if (!file) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
        return file;
      }),

    create: protectedProcedure
      .input(z.object({
        name: z.string(),
        mimeType: z.string().optional(),
        size: z.number(),
        folderId: z.number().optional(),
        storageMode: z.enum(["botStorage", "personalSavedMessages"]),
        routingReason: z.enum(["videoAlwaysPersonal", "imageUnderLimit", "imageOverflowToPersonal", "fileUnderLimit", "fileOverflowToPersonal", "userOverride"]),
        telegramDestination: z.string(),
        telegramFileId: z.string().optional(),
        telegramMessageId: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const file = await fileDb.createFile({
          userId: ctx.user.id,
          ...input,
        });
        return file;
      }),

    delete: protectedProcedure
      .input(z.object({ fileId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const file = await fileDb.getFile(input.fileId, ctx.user.id);
        if (!file) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
        await fileDb.deleteFile(input.fileId, ctx.user.id);
        return { success: true };
      }),

    move: protectedProcedure
      .input(z.object({ fileId: z.number(), folderId: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        const file = await fileDb.getFile(input.fileId, ctx.user.id);
        if (!file) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
        const updated = await fileDb.updateFile(input.fileId, ctx.user.id, { folderId: input.folderId });
        return updated;
      }),

    share: protectedProcedure
      .input(z.object({ fileId: z.number(), expiresIn: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        const file = await fileDb.getFile(input.fileId, ctx.user.id);
        if (!file) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });

        const token = nanoid(32);
        const expiresAt = input.expiresIn ? new Date(Date.now() + input.expiresIn) : undefined;

        await fileDb.createShareToken({
          fileId: input.fileId,
          userId: ctx.user.id,
          token,
          expiresAt,
        });

        await fileDb.updateFile(input.fileId, ctx.user.id, { shareToken: token, isShared: true });

        return { token, shareUrl: `/share/${token}` };
      }),

    getStats: protectedProcedure.query(async ({ ctx }) => {
      return fileDb.getStorageStats(ctx.user.id);
    }),
  }),

  folders: router({
    list: protectedProcedure
      .input(z.object({ parentId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        return fileDb.listFolders(ctx.user.id, input.parentId);
      }),

    create: protectedProcedure
      .input(z.object({ name: z.string(), parentId: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        return fileDb.createFolder({
          userId: ctx.user.id,
          name: input.name,
          parentId: input.parentId,
        });
      }),

    rename: protectedProcedure
      .input(z.object({ folderId: z.number(), name: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const folder = await fileDb.getFolder(input.folderId, ctx.user.id);
        if (!folder) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        return fileDb.updateFolder(input.folderId, ctx.user.id, { name: input.name });
      }),

    delete: protectedProcedure
      .input(z.object({ folderId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const folder = await fileDb.getFolder(input.folderId, ctx.user.id);
        if (!folder) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        await fileDb.deleteFolder(input.folderId, ctx.user.id);
        return { success: true };
      }),
  }),

  storage: router({
    getConfig: protectedProcedure.query(async ({ ctx }) => {
      const config = await fileDb.getStorageConfig(ctx.user.id);
      return config || {
        userId: ctx.user.id,
        isBotConfigured: false,
        isPersonalConfigured: false,
      };
    }),

    updateBotConfig: protectedProcedure
      .input(z.object({
        botToken: z.string(),
        botUsername: z.string(),
        botChannelId: z.string(),
        botChannelName: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        return fileDb.upsertStorageConfig(ctx.user.id, {
          botToken: input.botToken,
          botUsername: input.botUsername,
          botChannelId: input.botChannelId,
          botChannelName: input.botChannelName,
          isBotConfigured: true,
        });
      }),

    updatePersonalConfig: protectedProcedure
      .input(z.object({
        phoneNumber: z.string(),
        personalStorageMode: z.enum(["savedMessages", "dedicatedGroup"]),
        personalStorageGroupId: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return fileDb.upsertStorageConfig(ctx.user.id, {
          isPersonalConfigured: true,
          personalStorageMode: input.personalStorageMode,
          personalStorageGroupId: input.personalStorageGroupId,
        });
      }),
  }),

  routing: router({
    getDecision: publicProcedure
      .input(z.object({
        filename: z.string(),
        size: z.number(),
        mimeType: z.string().optional(),
      }))
      .query(({ input }) => {
        const decision = determineRouting(input.filename, input.size, input.mimeType || null);
        return {
          ...decision,
          explanation: getRoutingExplanation(decision),
          displayName: getStorageModeDisplayName(decision.storageMode),
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
