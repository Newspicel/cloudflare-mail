CREATE TABLE `app_password` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_password_user_idx` ON `app_password` (`user_id`);--> statement-breakpoint
CREATE INDEX `app_password_mailbox_idx` ON `app_password` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `imap_folder` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`folder_id` text,
	`key` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid_next` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folder`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_folder_key_uq` ON `imap_folder` (`user_id`,`mailbox_id`,`key`);--> statement-breakpoint
CREATE INDEX `imap_folder_folder_idx` ON `imap_folder` (`folder_id`);--> statement-breakpoint
CREATE TABLE `imap_uid` (
	`imap_folder_id` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`imap_folder_id`, `uid`),
	FOREIGN KEY (`imap_folder_id`) REFERENCES `imap_folder`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_uid_message_uq` ON `imap_uid` (`imap_folder_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `imap_uid_message_idx` ON `imap_uid` (`message_id`);