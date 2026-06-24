ALTER TABLE `draft` ADD `scheduled_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `draft` ADD `scheduled_error` text;