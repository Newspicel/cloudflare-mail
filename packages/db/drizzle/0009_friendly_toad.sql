ALTER TABLE `thread` ADD `trashed_at` integer;--> statement-breakpoint
CREATE INDEX `thread_trashed_at_idx` ON `thread` (`trashed_at`);--> statement-breakpoint
UPDATE `thread` SET `trashed_at` = (unixepoch()) WHERE `trashed` = 1 AND `trashed_at` IS NULL;