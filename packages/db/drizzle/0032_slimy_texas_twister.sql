ALTER TABLE `contact_key` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `contact_key` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `message` ADD `pgp_key_event` text;