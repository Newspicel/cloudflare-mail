CREATE TABLE `reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`remind_at` integer NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`fired_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reminder_status_remind_at_idx` ON `reminder` (`status`,`remind_at`);--> statement-breakpoint
CREATE INDEX `reminder_user_status_idx` ON `reminder` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `reminder_thread_kind_status_idx` ON `reminder` (`thread_id`,`kind`,`status`);