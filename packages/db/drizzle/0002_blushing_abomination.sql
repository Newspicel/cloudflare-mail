CREATE TABLE `mailbox_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`email` text NOT NULL,
	`perms` integer DEFAULT 0 NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_invite_mailbox_email_uq` ON `mailbox_invite` (`mailbox_id`,`email`);--> statement-breakpoint
CREATE INDEX `mailbox_invite_email_idx` ON `mailbox_invite` (`email`);--> statement-breakpoint
ALTER TABLE `thread` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `thread` ADD `trashed` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `thread_mailbox_state_idx` ON `thread` (`mailbox_id`,`archived`,`trashed`);