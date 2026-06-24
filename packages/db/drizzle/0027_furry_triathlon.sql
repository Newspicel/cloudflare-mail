ALTER TABLE `draft` ADD `scheduled_for` integer;--> statement-breakpoint
ALTER TABLE `draft` ADD `scheduled_payload` text;--> statement-breakpoint
CREATE INDEX `draft_scheduled_idx` ON `draft` (`scheduled_for`);