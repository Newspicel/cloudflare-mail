CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`inline` integer DEFAULT false NOT NULL,
	`content_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachment_message_idx` ON `attachment` (`message_id`);--> statement-breakpoint
CREATE TABLE `domain` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`is_temp_domain` integer DEFAULT false NOT NULL,
	`spf_ok` integer DEFAULT false NOT NULL,
	`dkim_ok` integer DEFAULT false NOT NULL,
	`dmarc_ok` integer DEFAULT false NOT NULL,
	`last_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_name_unique` ON `domain` (`name`);--> statement-breakpoint
CREATE INDEX `domain_kind_idx` ON `domain` (`kind`);--> statement-breakpoint
CREATE TABLE `label` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_mailbox_name_uq` ON `label` (`mailbox_id`,`name`);--> statement-breakpoint
CREATE TABLE `mailbox` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`display_name` text,
	`type` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`signature` text,
	`reply_to` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_domain_local_uq` ON `mailbox` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE INDEX `mailbox_owner_idx` ON `mailbox` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `mailbox_expires_idx` ON `mailbox` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mailbox_type_idx` ON `mailbox` (`type`);--> statement-breakpoint
CREATE TABLE `mailbox_member` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`perms` integer DEFAULT 0 NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_member_user_idx` ON `mailbox_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`direction` text NOT NULL,
	`message_id_hdr` text,
	`in_reply_to` text,
	`references` text,
	`from_name` text,
	`from_addr` text NOT NULL,
	`to_addrs` text DEFAULT '[]' NOT NULL,
	`cc_addrs` text,
	`bcc_addrs` text,
	`subject` text DEFAULT '' NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`flags` integer DEFAULT 0 NOT NULL,
	`received_at` integer,
	`sent_at` integer,
	`raw_r2_key` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_mailbox_created_idx` ON `message` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_thread_idx` ON `message` (`thread_id`);--> statement-breakpoint
CREATE INDEX `message_msgid_idx` ON `message` (`message_id_hdr`);--> statement-breakpoint
CREATE TABLE `message_label` (
	`message_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `label_id`),
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `share_token` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`perms` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_token_mailbox_idx` ON `share_token` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `thread` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`subject_norm` text DEFAULT '' NOT NULL,
	`last_msg_at` integer DEFAULT (unixepoch()) NOT NULL,
	`msg_count` integer DEFAULT 0 NOT NULL,
	`participants` text DEFAULT '[]' NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_mailbox_last_idx` ON `thread` (`mailbox_id`,`last_msg_at`);--> statement-breakpoint
CREATE INDEX `thread_mailbox_subject_idx` ON `thread` (`mailbox_id`,`subject_norm`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
