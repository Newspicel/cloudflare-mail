-- Per-mailbox spam filtering: level + AI token budget on mailbox, evaluation
-- result on message, and cumulative Workers AI usage accounting per mailbox.

ALTER TABLE `mailbox` ADD `spam_filter` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `spam_ai_token_cap` integer;--> statement-breakpoint
ALTER TABLE `message` ADD `spam_verdict` text;--> statement-breakpoint
ALTER TABLE `message` ADD `spam_score` integer;--> statement-breakpoint
ALTER TABLE `message` ADD `spam_reasons` text;--> statement-breakpoint
ALTER TABLE `message` ADD `spam_auth` text;--> statement-breakpoint
CREATE TABLE `mailbox_spam_usage` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`period` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
