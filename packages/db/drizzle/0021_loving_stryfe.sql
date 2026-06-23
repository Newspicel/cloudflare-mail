CREATE TABLE `rule` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`conditions` text DEFAULT '[]' NOT NULL,
	`condition_mode` text DEFAULT 'all' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_mailbox_name_uq` ON `rule` (`mailbox_id`,`name`);--> statement-breakpoint
CREATE INDEX `rule_mailbox_priority_idx` ON `rule` (`mailbox_id`,`priority`);