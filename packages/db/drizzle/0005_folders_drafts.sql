-- Spam folder: threads can be marked as spam (manual only — no auto-classifier).
ALTER TABLE `thread` ADD `spam` integer DEFAULT false NOT NULL;--> statement-breakpoint

-- The Archive folder was removed; drop the column and re-point the state index
-- at the live buckets. (Drop the index first — it references `archived`.)
DROP INDEX IF EXISTS `thread_mailbox_state_idx`;--> statement-breakpoint
ALTER TABLE `thread` DROP COLUMN `archived`;--> statement-breakpoint
CREATE INDEX `thread_mailbox_state_idx` ON `thread` (`mailbox_id`,`trashed`,`spam`);--> statement-breakpoint

-- Server-persisted compose drafts.
CREATE TABLE `draft` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`in_reply_to` text,
	`references` text,
	`to_addrs` text DEFAULT '[]' NOT NULL,
	`cc_addrs` text,
	`bcc_addrs` text,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`markdown` integer DEFAULT false NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_mailbox_idx` ON `draft` (`mailbox_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `draft_user_idx` ON `draft` (`user_id`);
