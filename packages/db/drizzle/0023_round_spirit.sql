CREATE TABLE `rule_send_log` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `rule`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_send_log_mailbox_sent_idx` ON `rule_send_log` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rule_send_log_rule_recipient_idx` ON `rule_send_log` (`rule_id`,`recipient`,`created_at`);