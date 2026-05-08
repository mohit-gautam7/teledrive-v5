CREATE TABLE `files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`folderId` int,
	`name` text NOT NULL,
	`mimeType` varchar(255),
	`size` bigint NOT NULL,
	`storageMode` enum('botStorage','personalSavedMessages','localAgent') NOT NULL,
	`routingReason` enum('videoAlwaysPersonal','imageUnderLimit','imageOverflowToPersonal','fileUnderLimit','fileOverflowToPersonal','userOverride') NOT NULL,
	`userOverriddenMode` enum('botStorage','personalSavedMessages'),
	`telegramDestination` varchar(255) NOT NULL,
	`telegramFileId` text,
	`telegramMessageId` varchar(255),
	`thumbnailUrl` text,
	`shareToken` varchar(255),
	`isShared` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deletedAt` timestamp,
	CONSTRAINT `files_id` PRIMARY KEY(`id`),
	CONSTRAINT `files_shareToken_unique` UNIQUE(`shareToken`)
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` text NOT NULL,
	`parentId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `folders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shareTokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fileId` int NOT NULL,
	`userId` int NOT NULL,
	`token` varchar(255) NOT NULL,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shareTokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `shareTokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `storageConfigs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`botToken` text,
	`botUsername` varchar(255),
	`botChannelId` varchar(255),
	`botChannelName` varchar(255),
	`personalStorageMode` enum('savedMessages','dedicatedGroup','none') DEFAULT 'none',
	`personalStorageGroupId` varchar(255),
	`isBotConfigured` boolean NOT NULL DEFAULT false,
	`isPersonalConfigured` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `storageConfigs_id` PRIMARY KEY(`id`),
	CONSTRAINT `storageConfigs_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `telegramSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`phoneNumber` varchar(20) NOT NULL,
	`sessionData` longtext NOT NULL,
	`isValid` boolean NOT NULL DEFAULT true,
	`lastValidated` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `telegramSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegramSessions_userId_unique` UNIQUE(`userId`)
);
