CREATE TABLE `block_request` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'email' NOT NULL,
	`value` text NOT NULL,
	`from_name` text,
	`subject` text,
	`note` text,
	`message_id` text,
	`mailbox_id` text,
	`requested_by_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by_user_id` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `block_request_status_idx` ON `block_request` (`status`);--> statement-breakpoint
CREATE INDEX `block_request_user_idx` ON `block_request` (`requested_by_user_id`);--> statement-breakpoint
CREATE TABLE `blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`reason` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_type_value_uq` ON `blocklist` (`type`,`value`);