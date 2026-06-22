-- Inbound-only aliases: mail to (domain_id, local_part) is delivered into a
-- target mailbox. No mailbox row exists for the alias, so it cannot send.
CREATE TABLE `redirect` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`target_mailbox_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redirect_domain_local_uq` ON `redirect` (`domain_id`, `local_part`);--> statement-breakpoint
CREATE INDEX `redirect_target_idx` ON `redirect` (`target_mailbox_id`);--> statement-breakpoint

-- Envelope recipient a message arrived at — differs from the mailbox address
-- when delivered via a redirect. Null for outbound.
ALTER TABLE `message` ADD `delivered_to` text;
