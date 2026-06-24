CREATE TABLE `mailbox_ai_usage` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`period` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mailbox` ADD `ai_features` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `ai_token_cap` integer;--> statement-breakpoint
ALTER TABLE `message` ADD `ai_summary` text;--> statement-breakpoint
ALTER TABLE `message` ADD `ai_category` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `ai_summary` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `ai_category` text;