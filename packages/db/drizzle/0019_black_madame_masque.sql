CREATE TABLE `contact_key` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`email` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source` text DEFAULT 'import' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_key_mailbox_email_uq` ON `contact_key` (`mailbox_id`,`email`);--> statement-breakpoint
ALTER TABLE `mailbox` ADD `pgp_mode` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `pgp_public_key` text;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `pgp_private_key_wrapped` text;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `pgp_passphrase_wrapped` text;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `pgp_fingerprint` text;--> statement-breakpoint
ALTER TABLE `message` ADD `pgp_encrypted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `pgp_signed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `pgp_verify` text;--> statement-breakpoint
ALTER TABLE `message` ADD `pgp_signed_by` text;--> statement-breakpoint
ALTER TABLE `message` ADD `plain_r2_key` text;